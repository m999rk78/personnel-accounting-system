import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { profileProjectChangeAllowed } from "../app/userAccessModel.ts";

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function compile(path,replacements={}) {
  let source=ts.transpileModule(await readFile(new URL(path,import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  for(const [specifier,replacement] of Object.entries({react:import.meta.resolve("react"),"react-dom":import.meta.resolve("react-dom"),"react/jsx-runtime":import.meta.resolve("react/jsx-runtime"),"./customRoles.css":moduleUrl(""),...replacements})) source=source.replaceAll(JSON.stringify(specifier),JSON.stringify(replacement));
  return moduleUrl(source);
}
const pickerUrl=await compile("../app/ProjectAccessPicker.tsx");
const selectUrl=await compile("../app/CustomSelect.tsx",{"./choiceMenuLayout":new URL("../app/choiceMenuLayout.ts",import.meta.url).href});
const {UserAccessCards}=await import(await compile("../app/UserAccessCards.tsx",{
  "./ProjectAccessPicker":pickerUrl,"./CustomSelect":selectUrl,"./roles":new URL("../app/roles.ts",import.meta.url).href,"./userAccessModel":new URL("../app/userAccessModel.ts",import.meta.url).href,
}));
const sites=[{id:7,name:"Северный объект"},{id:8,name:"Южный объект"}];
const draft=patch=>({key:"existing-user",id:1,fullName:"Проверяемый пользователь",email:"qa@invalid.test",role:"engineer",assignedSiteId:"",...patch});
const render=drafts=>renderToStaticMarkup(createElement(UserAccessCards,{rows:[],drafts,sites,selectedIds:[],onEdit(){},onSelectionChange(){},onPatchDraft(){},onCancelEditing(){},onSave(){},saving:false}));

test("profile project editing accepts any explicitly accessible project and rejects clearing restricted scope",()=>{
  assert.equal(profileProjectChangeAllowed([7,8],"8"),true);
  assert.equal(profileProjectChangeAllowed([7,8],"7"),true);
  for(const value of ["","9","__unassigned__"]) assert.equal(profileProjectChangeAllowed([7,8],value),false);
  assert.equal(profileProjectChangeAllowed([],"7"),false);
  assert.equal(profileProjectChangeAllowed(7,"7"),true);
  assert.equal(profileProjectChangeAllowed(undefined,""),true);
});

test("engineer no longer requires a single assigned project and viewer must select a project before inviting",()=>{
  const engineer=render([draft()]);
  assert.match(engineer,/Доступ ко всем текущим и новым проектам/);
  assert.doesNotMatch(engineer,/class="user-create-submit" disabled/);
  const viewer=render([draft({id:undefined,role:"viewer",projectAccess:{mode:"selected",siteIds:[]}})]);
  assert.match(viewer,/Выберите хотя бы один доступный проект/);
  assert.match(viewer,/class="user-create-submit" disabled=""/);
  assert.match(viewer,/<strong>Просмотр<\/strong>/);
  assert.doesNotMatch(viewer,/<strong>Админ<\/strong>/);
  assert.match(viewer,/По умолчанию доступны подтверждённые отчёты и табели/);
  const closed=render([draft({role:"viewer",projectAccess:{mode:"selected",siteIds:[]}})]);
  assert.doesNotMatch(closed,/class="user-create-submit" disabled/);
  const selected=render([draft({role:"viewer",projectAccess:{mode:"selected",siteIds:[7,8]}})]);
  assert.doesNotMatch(selected,/class="user-create-submit" disabled/);
  assert.equal((selected.match(/type="checkbox" checked=""/g)??[]).length,2);
});

test("batch editing identifies a user whose selected projects are missing or retired",()=>{
  const html=render([draft(),draft({key:"second",id:2,role:"viewer",fullName:"Второй пользователь",projectAccess:{mode:"selected",siteIds:[9]}})]);
  assert.match(html,/Выберите проект: пользователь 2 из 2 — Второй пользователь/);
  assert.match(html,/class="user-create-invalid-jump"/);
  assert.match(html,/class="user-create-submit" disabled=""/);
});
