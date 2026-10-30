import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { compressJsonResponse } from "../app/compressJsonResponse.ts";

test("large JSON is compressed as a stream and stays private, with identical records", async () => {
  const data = { employees: Array.from({length:10000},(_,id)=>({id,fullName:`Сотрудник ${id}`,employmentType:"ОПР"})) };
  const input = Response.json(data,{headers:{Vary:"Origin"}});
  const output = compressJsonResponse(new Request("http://localhost/api/data",{headers:{"Accept-Encoding":"br, gzip, deflate"}}),input);
  assert.equal(output.headers.get("Content-Encoding"),"gzip");
  assert.equal(output.headers.get("Cache-Control"),"private, no-store");
  assert.equal(output.headers.get("Vary"),"Origin, Accept-Encoding");
  assert.equal(output.headers.has("Content-Length"),false);
  const compressed = Buffer.from(await output.arrayBuffer());
  const raw = gunzipSync(compressed);
  assert.deepEqual(JSON.parse(raw),data);
  assert.ok(compressed.length<raw.length/5);
});

test("encoding negotiation respects an explicit gzip refusal, even with wildcard", async () => {
  for (const accepted of ["", "br", "gzip;q=0", "*;q=1, gzip;q=0", "gzip;q=invalid"]) {
    const output=compressJsonResponse(new Request("http://localhost",{headers:{"Accept-Encoding":accepted}}),Response.json({ok:true}));
    assert.equal(output.headers.has("Content-Encoding"),false,accepted);
    assert.deepEqual(await output.json(),{ok:true});
  }
});

test("errors and already encoded/non-JSON bodies retain their status and body", async () => {
  const request=new Request("http://localhost",{headers:{"Accept-Encoding":"gzip"}});
  const denied=compressJsonResponse(request,Response.json({error:"Нет доступа"},{status:403}));
  assert.equal(denied.status,403); assert.equal(denied.headers.has("Content-Encoding"),false);
  assert.deepEqual(await denied.json(),{error:"Нет доступа"});
  const encoded=compressJsonResponse(request,new Response("encoded",{headers:{"Content-Type":"application/json","Content-Encoding":"br"}}));
  assert.equal(encoded.headers.get("Content-Encoding"),"br"); assert.equal(await encoded.text(),"encoded");
  const file=compressJsonResponse(request,new Response("xlsx",{headers:{"Content-Type":"application/octet-stream"}}));
  assert.equal(file.headers.has("Content-Encoding"),false); assert.equal(await file.text(),"xlsx");
});
