import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import axios from "axios";
import { z } from "zod";
import { convertDocsWithNames } from "../api/documentEnhancer";
import {
  DEFAULT_TTL_SECONDS,
  FILES_ROUTE,
  fileLinks,
  filenameFromContentDisposition,
} from "../api/fileLinks";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { arrayNotEmpty, objectNotEmpty } from "./utils/empty";
import { withErrorHandling } from "./utils/middlewares";
import { validateCustomFields } from "./utils/monetary";
import { CUSTOM_FIELD_VALUE_DESCRIPTION } from "./utils/descriptions";

// Larger files go through paperless_file_link instead of base64 in the chat.
const MAX_INLINE_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const TASK_WAIT_MS = 20000;

function headerValue(headers: any, name: string): string | undefined {
  const value =
    typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
  return value == null ? undefined : String(value);
}

export async function fetchDocumentFile(
  api: PaperlessAPI,
  id: number,
  original = false
) {
  const response = await api.downloadDocument(id, original);
  const data = Buffer.from(response.data);
  const filename = filenameFromContentDisposition(
    headerValue(response.headers, "content-disposition"),
    `document-${id}.pdf`
  );
  const mimeType =
    headerValue(response.headers, "content-type")?.split(";")[0].trim() ||
    "application/octet-stream";
  return { data, filename, mimeType };
}

async function loadUploadSource(args: { file?: string; url?: string }) {
  if (args.url) {
    if (!/^https?:\/\//i.test(args.url)) {
      throw new Error("url must be an http(s) URL.");
    }
    const response = await axios.get<ArrayBuffer>(args.url, {
      responseType: "arraybuffer",
      timeout: 60000,
      maxContentLength: MAX_UPLOAD_BYTES,
    });
    return Buffer.from(response.data);
  }
  if (!args.file) {
    throw new Error("Either 'file' (base64) or 'url' is required.");
  }
  // Accept data URLs and line-wrapped base64.
  const base64 = args.file.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error(
      "Invalid base64-encoded file data. Please provide a valid base64 string."
    );
  }
  return Buffer.from(base64, "base64");
}

async function waitForConsumeTask(api: PaperlessAPI, taskId: string) {
  const deadline = Date.now() + TASK_WAIT_MS;
  let task: any;
  while (Date.now() < deadline) {
    const tasks = await api.request<any[]>(
      `/tasks/?task_id=${encodeURIComponent(taskId)}`
    );
    task = Array.isArray(tasks) ? tasks[0] : undefined;
    if (task && ["SUCCESS", "FAILURE", "REVOKED"].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return task;
}

export interface DocumentToolOptions {
  /** Public URL of this MCP server; enables paperless_file_link. */
  fileLinkBaseUrl?: string;
}

export function registerDocumentTools(
  server: McpServer,
  api: PaperlessAPI,
  options: DocumentToolOptions = {}
) {
  server.tool(
    "bulk_edit_documents",
    "Perform bulk operations on multiple documents. Note: 'remove_tag' removes a tag from specific documents (tag remains in system), while 'delete_tag' permanently deletes a tag from the entire system. ⚠️ WARNING: 'delete' method permanently deletes documents and requires confirmation.",
    {
      documents: z.array(z.number()),
      method: z.enum([
        "set_correspondent",
        "set_document_type",
        "set_storage_path",
        "add_tag",
        "remove_tag",
        "modify_tags",
        "modify_custom_fields",
        "delete",
        "reprocess",
        "set_permissions",
        "merge",
        "split",
        "rotate",
        "delete_pages",
      ]),
      correspondent: z.number().optional(),
      document_type: z.number().optional(),
      storage_path: z.number().optional(),
      tag: z.number().optional(),
      add_tags: z.array(z.number()).optional().transform(arrayNotEmpty),
      remove_tags: z.array(z.number()).optional().transform(arrayNotEmpty),
      add_custom_fields: z
        .array(
          z.object({
            field: z.number(),
            value: z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.number()),
              z.null(),
            ]).describe(CUSTOM_FIELD_VALUE_DESCRIPTION),
          })
        )
        .optional()
        .transform(arrayNotEmpty),
      remove_custom_fields: z
        .array(z.number())
        .optional()
        .transform(arrayNotEmpty),
      permissions: z
        .object({
          owner: z.number().nullable().optional(),
          set_permissions: z
            .object({
              view: z.object({
                users: z.array(z.number()),
                groups: z.array(z.number()),
              }),
              change: z.object({
                users: z.array(z.number()),
                groups: z.array(z.number()),
              }),
            })
            .optional(),
          merge: z.boolean().optional(),
        })
        .optional()
        .transform(objectNotEmpty),
      metadata_document_id: z.number().optional(),
      delete_originals: z.boolean().optional(),
      pages: z.string().optional(),
      degrees: z.number().optional(),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Must be true when method is 'delete' to confirm destructive operation"
        ),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      if (args.method === "delete" && !args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      const { documents, method, add_custom_fields, confirm, ...parameters } = args;

      validateCustomFields(add_custom_fields);

      // Transform add_custom_fields into the two separate API parameters
      const apiParameters = { ...parameters };
      if (add_custom_fields && add_custom_fields.length > 0) {
        apiParameters.assign_custom_fields = add_custom_fields.map(
          (cf) => cf.field
        );
        apiParameters.assign_custom_fields_values = add_custom_fields;
      }

      const response = await api.bulkEditDocuments(
        documents,
        method,
        apiParameters
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ result: response.result || response }),
          },
        ],
      };
    })
  );

  server.tool(
    "post_document",
    "Upload a new document to Paperless-NGX with optional metadata like title, correspondent, document type, tags, and custom fields. Pass the file either as 'url' (preferred for anything but tiny files, e.g. a single-use link from elster_file_link or a OneDrive/HERO download link; the server fetches it itself) or as base64 in 'file'. Waits up to 20 s for Paperless to consume it and returns the new document id when done, otherwise the task id.",
    {
      file: z.string().optional().describe("Base64-encoded file content"),
      url: z
        .string()
        .optional()
        .describe("http(s) URL the server downloads the file from instead of 'file'"),
      filename: z.string(),
      title: z.string().optional(),
      created: z.string().optional(),
      correspondent: z.number().optional(),
      document_type: z.number().optional(),
      storage_path: z.number().optional(),
      tags: z.array(z.number()).optional(),
      archive_serial_number: z.number().optional(),
      custom_fields: z.array(z.number()).optional(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const { file, url, filename, ...metadata } = args;
      const document = await loadUploadSource({ file, url });
      if (document.length === 0) throw new Error("The file is empty.");

      const response = await api.postDocument(document, filename, metadata);
      let result: Record<string, unknown>;
      if (typeof response === "string" && /^\d+$/.test(response)) {
        result = { id: Number(response) };
      } else if (typeof response === "string") {
        const task = await waitForConsumeTask(api, response);
        result = {
          task_id: response,
          status: task?.status ?? "PENDING",
          ...(task?.related_document
            ? { id: Number(task.related_document) }
            : {}),
          ...(task?.status === "FAILURE" ? { error: task.result } : {}),
        };
      } else {
        result = { status: response };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...result, size: document.length }),
          },
        ],
      };
    })
  );

  server.tool(
    "list_documents",
    "List and filter documents by fields such as title, correspondent, document type, tag, storage path, creation date, and more. IMPORTANT: For queries like 'the last 3 contributions' or when searching by tag, correspondent, document type, or storage path, you should FIRST use the relevant tool (e.g., 'list_tags', 'list_correspondents', 'list_document_types', 'list_storage_paths') to find the correct ID, and then use that ID as a filter here. Only use the 'search' argument for free-text search when no specific field applies. Using the correct ID filter will yield much more accurate results. Note: Document content is excluded from results by default. Use 'get_document_content' to retrieve content when needed.",
    {
      page: z.number().optional(),
      page_size: z.number().optional(),
      search: z.string().optional(),
      correspondent: z.number().optional(),
      document_type: z.number().optional(),
      tag: z.number().optional(),
      storage_path: z.number().optional(),
      created__date__gte: z.string().optional(),
      created__date__lte: z.string().optional(),
      ordering: z.string().optional(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const query = new URLSearchParams();
      if (args.page) query.set("page", args.page.toString());
      if (args.page_size) query.set("page_size", args.page_size.toString());
      if (args.search) query.set("search", args.search);
      if (args.correspondent)
        query.set("correspondent__id", args.correspondent.toString());
      if (args.document_type)
        query.set("document_type__id", args.document_type.toString());
      if (args.tag) query.set("tags__id", args.tag.toString());
      if (args.storage_path)
        query.set("storage_path__id", args.storage_path.toString());
      if (args.created__date__gte) query.set("created__date__gte", args.created__date__gte);
      if (args.created__date__lte) query.set("created__date__lte", args.created__date__lte);
      if (args.ordering) query.set("ordering", args.ordering);

      const docsResponse = await api.getDocuments(
        query.toString() ? `?${query.toString()}` : ""
      );
      return convertDocsWithNames(docsResponse, api);
    })
  );

  server.tool(
    "get_document",
    "Get a specific document by ID with full details including correspondent, document type, tags, and custom fields. Note: Document content is excluded from results by default. Use 'get_document_content' to retrieve content when needed.",
    {
      id: z.number(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const doc = await api.getDocument(args.id);
      return convertDocsWithNames(doc, api);
    })
  );

  server.tool(
    "get_document_content",
    "Get the text content of a specific document by ID. Use this when you need to read or analyze the actual document text.",
    {
      id: z.number(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const doc = await api.getDocument(args.id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: doc.id,
              title: doc.title,
              content: doc.content,
            }),
          },
        ],
      };
    })
  );

  server.tool(
    "search_documents",
    "Full text search for documents. This tool is for searching document content, title, and metadata using a full text query. For general document listing or filtering by fields, use 'list_documents' instead. Note: Document content is excluded from results by default. Use 'get_document_content' to retrieve content when needed.",
    {
      query: z.string(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const docsResponse = await api.searchDocuments(args.query);
      return convertDocsWithNames(docsResponse, api);
    })
  );

  server.tool(
    "download_document",
    `Download a document file by ID. Returns the document as a base64-encoded resource (archived PDF by default, original file with original=true). Files over ${MAX_INLINE_BYTES / 1024 / 1024} MB are refused; to hand a file to another server (OneDrive, HERO) use paperless_file_link instead.`,
    {
      id: z.number(),
      original: z.boolean().optional(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const { data, filename, mimeType } = await fetchDocumentFile(
        api,
        args.id,
        args.original
      );
      if (data.length > MAX_INLINE_BYTES) {
        throw new Error(
          `Document is ${data.length} bytes, too large to return inline. Use paperless_file_link.`
        );
      }
      return {
        content: [
          {
            type: "resource",
            resource: {
              uri: `paperless://documents/${args.id}/${
                args.original ? "original" : "archive"
              }/${encodeURIComponent(filename)}`,
              mimeType,
              blob: data.toString("base64"),
            },
          },
        ],
      };
    })
  );

  if (options.fileLinkBaseUrl) {
    const baseUrl = options.fileLinkBaseUrl.replace(/\/+$/, "");
    server.tool(
      "paperless_file_link",
      "Create a single-use download link (valid 10 minutes) for a document. Pass the link as 'sourceUrl' to e.g. onedrive-upload or to HERO, so that server fetches the file itself and no base64 has to go through the chat. The link works exactly once; create a new one for a retry.",
      {
        id: z.number().describe("Document ID"),
        original: z
          .boolean()
          .optional()
          .describe("true = original upload, default = archived PDF"),
      },
      withErrorHandling(async (args, extra) => {
        if (!api) throw new Error("Please configure API connection first");
        // Fails with 404 for unknown documents, so no dead links are handed out.
        const doc = await api.getDocument(args.id);
        const token = fileLinks.create({
          documentId: args.id,
          original: Boolean(args.original),
        });
        console.log(`file_link created for document ${args.id}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: args.id,
                title: doc.title,
                filename: args.original
                  ? doc.original_file_name
                  : doc.archived_file_name ?? doc.original_file_name,
                url: baseUrl + FILES_ROUTE + token,
                expiresInSeconds: DEFAULT_TTL_SECONDS,
                singleUse: true,
              }),
            },
          ],
        };
      })
    );
  }

  server.tool(
    "get_document_thumbnail",
    "Get a document thumbnail (image preview) by ID. Returns the thumbnail as a base64-encoded WebP image resource.",
    {
      id: z.number(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const response = await api.getThumbnail(args.id);
      return {
        content: [
          {
            type: "resource",
            resource: {
              uri: `document-${args.id}-thumb.webp`,
              blob: Buffer.from(response.data).toString("base64"),
              mimeType: "image/webp",
            },
          },
        ],
      };
    })
  );

  server.tool(
    "update_document",
    "Update a specific document with new values. This tool allows you to modify any document field including title, correspondent, document type, storage path, tags, custom fields, and more. Only the fields you specify will be updated.",
    {
      id: z.number().describe("The ID of the document to update"),
      title: z
        .string()
        .max(128)
        .optional()
        .describe("The new title for the document (max 128 characters)"),
      correspondent: z
        .number()
        .nullable()
        .optional()
        .describe("The ID of the correspondent to assign"),
      document_type: z
        .number()
        .nullable()
        .optional()
        .describe("The ID of the document type to assign"),
      storage_path: z
        .number()
        .nullable()
        .optional()
        .describe("The ID of the storage path to assign"),
      tags: z
        .array(z.number())
        .optional()
        .describe("Array of tag IDs to assign to the document"),
      content: z
        .string()
        .optional()
        .describe("The raw text content of the document (used for searching)"),
      created: z
        .string()
        .optional()
        .describe("The creation date in YYYY-MM-DD format"),
      archive_serial_number: z
        .number()
        .optional()
        .describe("The archive serial number (0-4294967295)"),
      owner: z
        .number()
        .nullable()
        .optional()
        .describe("The ID of the user who owns the document"),
      custom_fields: z
        .array(
          z.object({
            field: z.number().describe("The custom field ID"),
            value: z
              .union([
                z.string(),
                z.number(),
                z.boolean(),
                z.array(z.number()),
                z.null(),
              ])
              .describe(CUSTOM_FIELD_VALUE_DESCRIPTION),
          })
        )
        .optional()
        .describe("Array of custom field values to assign"),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const { id, ...updateData } = args;

      validateCustomFields(updateData.custom_fields);

      const response = await api.updateDocument(id, updateData);

      return convertDocsWithNames(response, api);
    })
  );
}
