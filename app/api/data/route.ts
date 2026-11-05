import { compressJsonResponse } from "../../compressJsonResponse";
import { withAuditTrail } from "../../auditLog";
import { handleGET } from "../../server/data/readWorkspace";
import { handlePOST } from "../../server/data/createData";
import { handlePATCH } from "../../server/data/updateData";
import { handleDELETE } from "../../server/data/deleteData";

export async function GET(request: Request) {
  return compressJsonResponse(request, await handleGET(request));
}

export async function POST(request: Request) {
  return withAuditTrail(request, handlePOST);
}

export async function PATCH(request: Request) {
  return withAuditTrail(request, handlePATCH);
}

export async function DELETE(request: Request) {
  return withAuditTrail(request, handleDELETE);
}
