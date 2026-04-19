import { google } from "googleapis"

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI
const FRONT_END_URL = process.env.FRONT_END_URL

function getAuthClient() {
  if (
    !GOOGLE_CLIENT_ID ||
    !GOOGLE_CLIENT_SECRET ||
    !GOOGLE_REFRESH_TOKEN
  ) {
    throw new Error("Missing Google OAuth environment variables")
  }

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  )

  oauth2Client.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN,
  })

  return oauth2Client
}

async function getOrCreateUserFolder(drive, userName) {
  const safeName = userName.replace(/[^\w\s.\-]/g, "").trim() || "Unknown User"

  const search = await drive.files.list({
    q: `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and '${ROOT_FOLDER_ID}' in parents and trashed=false`,
    fields: "files(id,name)",
  })

  if (search.data.files.length > 0) {
    return search.data.files[0].id
  }

  const folder = await drive.files.create({
    requestBody: {
      name: safeName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [ROOT_FOLDER_ID],
    },
    fields: "id",
  })

  return folder.data.id
}

async function findExistingFile(drive, folderId, fileName) {
  const search = await drive.files.list({
    q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
    fields: "files(id,name)",
  })

  return search.data.files.length > 0 ? search.data.files[0].id : null
}

// ── Extract a Drive file ID from a view URL ──────────────────────────────────
// Handles:
//   https://drive.google.com/file/d/FILE_ID/view
//   https://drive.google.com/open?id=FILE_ID
function extractFileId(url) {
  if (!url) return null
  // /file/d/FILE_ID/...
  const matchPath = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/)
  if (matchPath) return matchPath[1]
  // ?id=FILE_ID
  const matchQuery = url.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if (matchQuery) return matchQuery[1]
  return null
}

export async function deleteFile(fileUrl) {
  // ── DELETE: remove a file from Drive by its view URL ──────────────────────
  if (fileUrl) {
    try {
      const fileId = extractFileId(fileUrl)

      if (!fileId) {
        throw new Error("Invalid or missing fileUrl")
      }

      const auth = getAuthClient()
      const drive = google.drive({ version: "v3", auth })

      // Permanently delete — use trash: true if you'd rather soft-delete
      await drive.files.delete({ fileId })

      return 'success'
    } catch (error) {
      // 404 from Drive means the file was already gone — treat as success
      if (error?.code === 404 || error?.status === 404) {
        return 'success'
      }
      console.error("DELETE ERROR:", error)
      throw new Error(error.message)
    }
  } else return
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()

  // ── POST: upload / replace a file ─────────────────────────────────────────
  if (req.method === "POST") {
    try {
      const { fileName, userName, mimeType } = req.body

      const auth = getAuthClient()
      const drive = google.drive({ version: "v3", auth })

      const userFolderId = await getOrCreateUserFolder(drive, userName)
      const existingFileId = await findExistingFile(drive, userFolderId, fileName)

      let uploadUrl = null;

      if (existingFileId) {
        // 1. UPDATE EXISTING FILE
        // Google requires a PATCH request to the specific file ID
        const res = await drive.files.update(
          {
            fileId: existingFileId,
            // You only need requestBody here if you also want to rename the file during update
            media: { mimeType: mimeType || 'application/octet-stream' }
          },
          {
            // Override the standard API call to initialize a resumable session
            url: `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=resumable`,
            method: 'PATCH'
          }
        );

        // V3 API requires the use of its built-in methods 
        // (get, set, has, keys) to interact with it instead
        // of the regular object fetching
        uploadUrl = res.headers.get('location');

      } else {
        // 2. CREATE NEW FILE
        // Google requires a POST request to the base files endpoint
        const res = await drive.files.create(
          {
            requestBody: {
              name: fileName,
              parents: [userFolderId]
            },
            media: { mimeType: mimeType || 'application/octet-stream' }
          },
          {
            // Override the standard API call to initialize a resumable session
            url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
            method: 'POST',
            headers: {
              'Origin': FRONT_END_URL
            }
          }
        );
        uploadUrl = res.headers.get('location');
      }

      if (!uploadUrl) {
        throw new Error("Failed to retrieve resumable upload URL from Google Drive");
      }
      return res.status(200).json({ uploadUrl: uploadUrl });

    } catch (error) {
      console.error("UPLOAD ERROR:", error)
      return res.status(500).json({
        error: "Upload failed",
        detail: error.message,
      })
    }
  } else return res.status(405).json({ error: "Method not allowed" })
}