/**
 * WhatsApp Sales Team CRM
 * Google Apps Script backend
 * Google Sheets database + WhatsApp Cloud API
 */

var CURRENT_ACTOR_ID = "";

const SHEETS = {
  Contacts: ["id","name","phone","email","company","source","ownerId","stage","value","lastContact","notes","createdAt"],
  Conversations: ["id","contactId","phone","contactName","ownerId","status","stage","lastMessage","lastMessageAt","unread","value","createdAt"],
  Messages: ["id","conversationId","contactId","direction","body","senderId","timestamp","status","waMessageId"],
  Team: ["id","name","email","role","phone","active"],
  Templates: ["id","name","body","category","active"],
  FollowUps: ["id","contactId","conversationId","ownerId","dueAt","note","status","createdAt","automationEnabled"],
  Settings: ["key","value","updatedAt"],
  AuditLog: ["id","actorId","action","recordType","recordId","details","timestamp"],
  Users: ["id","name","email","role","passwordHash","salt","active","createdAt","lastLogin"],
  Products: ["id","sku","name","description","price","stock","reorderLevel","active","updatedAt"],
  Quotations: ["id","number","contactId","itemsJson","subtotal","tax","total","status","validUntil","createdBy","createdAt"],
  Invoices: ["id","number","quotationId","contactId","itemsJson","subtotal","tax","total","status","dueDate","paidAt","createdBy","createdAt"],
  AutomationLog: ["id","followUpId","contactId","status","message","timestamp"]
};

function doGet(e) {
  const params = (e && e.parameter) || {};

  // WhatsApp webhook verification
  if (params["hub.mode"] === "subscribe" && params["hub.challenge"]) {
    const verify = getProp_("WHATSAPP_VERIFY_TOKEN");
    if (params["hub.verify_token"] === verify) {
      return ContentService.createTextOutput(params["hub.challenge"])
        .setMimeType(ContentService.MimeType.TEXT);
    }
    return ContentService.createTextOutput("Forbidden")
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // JSON API
  if (params.action) {
    return json_(routeGet_(params));
  }

  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle("WhatsApp Sales Team CRM")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  // WhatsApp sends JSON here.
  const raw = e && e.postData && e.postData.contents ? e.postData.contents : "";
  if (raw) {
    try {
      const payload = JSON.parse(raw);
      if (payload.entry) {
        processWhatsAppWebhook_(payload);
        return json_({ok:true});
      }
      // Netlify frontend API requests send structured JSON with {action, payload}.
      if (payload.action) {
        const data = payload.payload && typeof payload.payload === "object" ? payload.payload : {};
        return json_(routePost_(String(payload.action), data));
      }
    } catch (err) {
      // Continue below for app API requests.
    }
  }

  const params = e && e.parameter ? e.parameter : {};
  const action = params.action || "";
  return json_(routePost_(action, params));
}

function routeGet(p) {
  return routeGet_(p || {});
}

function routePost(action, p) {
  return routePost_(action || "", p || {});
}

function routeGet_(p) {
  const action = p.action;
  if (action === "login") return login_(p.email, p.password);
  if (action === "logout") { revokeSession_(p.token); return {ok:true}; }
  const auth = requireAuth_(p.token);
  if (!auth.ok) return auth;
  if (action === "bootstrap") {
    return {ok:true, user:{id:auth.user.id,name:auth.user.name,email:auth.user.email,role:auth.user.role,permissions:permissionsFor_(auth.user.role)},
      contacts:readSheet_("Contacts"),conversations:readSheet_("Conversations"),messages:readSheet_("Messages"),team:readSheet_("Team"),templates:readSheet_("Templates"),followUps:readSheet_("FollowUps"),products:readSheet_("Products"),quotations:readSheet_("Quotations"),invoices:readSheet_("Invoices"),auditLog:hasPermission_(auth.user,"view_audit")?readSheet_("AuditLog"):[],automationLog:hasPermission_(auth.user,"manage_settings")?readSheet_("AutomationLog"):[]};
  }
  if (action === "auditLog") { if (!hasPermission_(auth.user,"view_audit")) return {ok:false,error:"Permission denied."}; return {ok:true,data:readSheet_("AuditLog")}; }
  return {ok:false,error:"Unknown action"};
}

function routePost_(action, p) {
  if (action === "login") return login_(p.email,p.password);
  if (action === "logout") { revokeSession_(p.token); return {ok:true}; }
  if (action === "setupAdmin") return {ok:false,error:"Use setupInitialAdminFromProperties() after setting the one-time INITIAL_ADMIN_* Script Properties."};
  const auth = requireAuth_(p.token); if (!auth.ok) return auth;
  const user = auth.user; CURRENT_ACTOR_ID = user.id;
  if (action === "sendMessage") {
    if (!hasPermission_(user,"send_messages")) return {ok:false,error:"Permission denied."};
    const result=sendWhatsAppMessage_(p.to,p.body); if(!result.ok)return result;
    const convId=p.conversationId||uid_("conv"),contactId=p.contactId||uid_("contact"),sentAt=new Date().toISOString();
    appendObject_("Messages",{id:uid_("msg"),conversationId:convId,contactId:contactId,direction:"outbound",body:p.body||"",senderId:user.id,timestamp:sentAt,status:result.demo?"demo":"sent",waMessageId:result.messageId||""});
    updateById_("Conversations",convId,{lastMessage:p.body||"",lastMessageAt:sentAt,unread:"0"});
    updateById_("Contacts",contactId,{lastContact:sentAt});
    audit_("SEND_WHATSAPP","Message",convId,{to:p.to,demo:!!result.demo}); return result;
  }
  if (action === "saveContact") {
    if (!hasPermission_(user,"manage_contacts")) return {ok:false,error:"Permission denied."};
    const obj={id:p.id||uid_("contact"),name:p.name||"",phone:p.phone||"",email:p.email||"",company:p.company||"",source:p.source||"WhatsApp",ownerId:p.ownerId||user.id,stage:p.stage||"New",value:p.value||"0",lastContact:new Date().toISOString(),notes:p.notes||"",createdAt:p.createdAt||new Date().toISOString()};
    appendObject_("Contacts",obj); audit_("CREATE","Contact",obj.id,{name:obj.name}); return {ok:true};
  }
  if (action === "saveFollowUp") {
    if (!hasPermission_(user,"manage_followups")) return {ok:false,error:"Permission denied."};
    const obj={id:p.id||uid_("follow"),contactId:p.contactId||"",conversationId:p.conversationId||"",ownerId:p.ownerId||user.id,dueAt:p.dueAt||"",note:p.note||"",status:p.status||"Open",createdAt:new Date().toISOString(),automationEnabled:String(p.automationEnabled||"FALSE")};
    appendObject_("FollowUps",obj); audit_("CREATE","FollowUp",obj.id,{dueAt:obj.dueAt,automationEnabled:obj.automationEnabled}); return {ok:true};
  }
  if (action === "updateContact") { if(!hasPermission_(user,"manage_contacts"))return {ok:false,error:"Permission denied."}; const id=String(p.id||""),patch={}; ["name","phone","email","company","source","ownerId","stage","value","lastContact","notes"].forEach(k=>{if(Object.prototype.hasOwnProperty.call(p,k))patch[k]=p[k];}); if(!id||!updateById_("Contacts",id,patch))return {ok:false,error:"Contact not found."}; audit_("UPDATE","Contact",id,patch); return {ok:true}; }
  if (action === "updateFollowUp") {
    if (!hasPermission_(user,"manage_followups")) return {ok:false,error:"Permission denied."};
    const id=String(p.id||"");
    const status=String(p.status||"Done");
    if (!id || !updateById_("FollowUps",id,{status})) return {ok:false,error:"Follow-up not found."};
    audit_("UPDATE","FollowUp",id,{status});
    return {ok:true};
  }
  if (action === "markRead") {
    if (!hasPermission_(user,"send_messages")) return {ok:false,error:"Permission denied."};
    const id=String(p.id||"");
    if (!id || !updateById_("Conversations",id,{unread:"0"})) return {ok:false,error:"Conversation not found."};
    audit_("MARK_READ","Conversation",id,{});
    return {ok:true};
  }
  if (action === "saveTeamMember") { if(!hasPermission_(user,"manage_users"))return {ok:false,error:"Permission denied."}; const obj={id:p.id||uid_("user"),name:p.name||"",email:p.email||"",role:p.role||"Sales",phone:p.phone||"",active:p.active||"TRUE"};if(!obj.name)return {ok:false,error:"Team member name is required."};appendObject_("Team",obj);audit_("CREATE","Team",obj.id,{name:obj.name,role:obj.role});return {ok:true}; }
  if (action === "updateTeamMember") { if(!hasPermission_(user,"manage_users"))return {ok:false,error:"Permission denied."};const id=String(p.id||"");if(!id||!updateById_("Team",id,{active:p.active||"TRUE"}))return {ok:false,error:"Team member not found."};audit_("UPDATE","Team",id,{active:p.active||"TRUE"});return {ok:true}; }
  if (action === "saveTemplate") { if(!hasPermission_(user,"manage_templates"))return {ok:false,error:"Permission denied."};const obj={id:p.id||uid_("template"),name:p.name||"",body:p.body||"",category:p.category||"General",active:p.active||"TRUE"};if(!obj.name||!obj.body)return {ok:false,error:"Template name and body are required."};appendObject_("Templates",obj);audit_("CREATE","Template",obj.id,{name:obj.name});return {ok:true}; }
  if (action === "saveProduct") { if(!hasPermission_(user,"manage_products"))return {ok:false,error:"Permission denied."};const obj={id:p.id||uid_("product"),sku:p.sku||uid_("SKU"),name:String(p.name||"").trim(),description:p.description||"",price:Number(p.price||0),stock:Math.max(0,Number(p.stock||0)),reorderLevel:Math.max(0,Number(p.reorderLevel||0)),active:p.active||"TRUE",updatedAt:new Date().toISOString()};if(!obj.name||obj.price<0)return {ok:false,error:"Product name and a non-negative price are required."};appendObject_("Products",obj);audit_("CREATE","Product",obj.id,{name:obj.name,stock:obj.stock});return {ok:true}; }
  if (action === "adjustStock") { if(!hasPermission_(user,"manage_products"))return {ok:false,error:"Permission denied."};const id=String(p.id||""),prod=readSheet_("Products").find(x=>x.id===id);if(!prod)return {ok:false,error:"Product not found."};const next=Number(prod.stock||0)+Number(p.change||0);if(next<0)return {ok:false,error:"Stock cannot be negative."};updateById_("Products",id,{stock:next,updatedAt:new Date().toISOString()});audit_("STOCK_ADJUST","Product",id,{before:prod.stock,change:Number(p.change||0),after:next});return {ok:true,stock:next}; }
  if (action === "createQuotation" || action === "createInvoice") { if(!hasPermission_(user,"manage_sales_docs"))return {ok:false,error:"Permission denied."};const rows=Array.isArray(p.items)?p.items:[];if(!p.contactId||!rows.length)return {ok:false,error:"Choose a customer and at least one product."};let subtotal=0;const normalized=[];for(const item of rows){const product=readSheet_("Products").find(x=>x.id===item.productId);const qty=Math.max(1,Number(item.quantity||1));if(!product||Number(product.stock||0)<qty&&action==="createInvoice")return {ok:false,error:"Product missing or insufficient stock: "+(product?product.name:"unknown")};const price=Number(product.price||0);subtotal+=price*qty;normalized.push({productId:product.id,sku:product.sku,name:product.name,quantity:qty,unitPrice:price,lineTotal:price*qty});}const tax=Math.max(0,Number(p.tax||0)),total=subtotal+tax,now=new Date().toISOString();const isInvoice=action==="createInvoice";const id=uid_(isInvoice?"inv":"quo"),number=(isInvoice?"INV-":"QUO-")+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),"yyyyMMdd")+"-"+id.slice(-5).toUpperCase();const obj=isInvoice?{id,number,quotationId:p.quotationId||"",contactId:p.contactId,itemsJson:JSON.stringify(normalized),subtotal,tax,total,status:"Unpaid",dueDate:p.dueDate||"",paidAt:"",createdBy:user.id,createdAt:now}:{id,number,contactId:p.contactId,itemsJson:JSON.stringify(normalized),subtotal,tax,total,status:"Draft",validUntil:p.validUntil||"",createdBy:user.id,createdAt:now};appendObject_(isInvoice?"Invoices":"Quotations",obj);if(isInvoice)normalized.forEach(it=>{const prod=readSheet_("Products").find(x=>x.id===it.productId);updateById_("Products",it.productId,{stock:Number(prod.stock||0)-it.quantity,updatedAt:now});});audit_("CREATE",isInvoice?"Invoice":"Quotation",id,{number,total});return {ok:true,id,number,total}; }
  if (action === "updateDocumentStatus") { if(!hasPermission_(user,"manage_sales_docs"))return {ok:false,error:"Permission denied."};const type=p.type==="Invoice"?"Invoices":"Quotations",id=String(p.id||""),patch={status:String(p.status||"")};if(type==="Invoices"&&patch.status==="Paid")patch.paidAt=new Date().toISOString();if(!updateById_(type,id,patch))return {ok:false,error:"Document not found."};audit_("STATUS_CHANGE",p.type||"Quotation",id,patch);return {ok:true}; }
  if (action === "createLoginUser") { if(!hasPermission_(user,"manage_users"))return {ok:false,error:"Permission denied."};return createLoginUser_(p); }
  if (action === "enableFollowupAutomation") { if(!hasPermission_(user,"manage_settings"))return {ok:false,error:"Permission denied."};installFollowupTrigger_();setSetting_("FOLLOWUP_AUTOMATION","TRUE");audit_("ENABLE_AUTOMATION","Settings","FOLLOWUP_AUTOMATION",{});return {ok:true}; }
  if (action === "disableFollowupAutomation") { if(!hasPermission_(user,"manage_settings"))return {ok:false,error:"Permission denied."};ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==="processAutomatedFollowUps").forEach(t=>ScriptApp.deleteTrigger(t));setSetting_("FOLLOWUP_AUTOMATION","FALSE");audit_("DISABLE_AUTOMATION","Settings","FOLLOWUP_AUTOMATION",{});return {ok:true}; }
  return {ok:false,error:"Unknown POST action"};
}

function setupInitialAdmin(email,name,password) {
  const normalizedEmail=String(email||"").trim().toLowerCase();
  if(!/^\S+@\S+\.\S+$/.test(normalizedEmail)) throw new Error("Provide a valid administrator email address.");
  if(!password||String(password).length<12) throw new Error("Use a unique password of at least 12 characters.");
  if(!getProp_("SPREADSHEET_ID")) throw new Error("Set SPREADSHEET_ID in Script Properties first.");
  if(!SpreadsheetApp.openById(getProp_("SPREADSHEET_ID")).getSheetByName("Users")) throw new Error("Run setupSheets() first so the Users sheet exists.");
  if(readSheet_("Users").length) throw new Error("A login user already exists. Ask an administrator to create users.");
  const result=createLoginUser_({email:normalizedEmail,name:name||"Administrator",password:password,role:"Admin"});
  if(!result.ok) throw new Error(result.error||"Could not create administrator.");
  return "Initial administrator created. Sign in with the supplied email and password.";
}
function setupInitialAdminFromProperties() {
  const props=PropertiesService.getScriptProperties();
  const email=props.getProperty("INITIAL_ADMIN_EMAIL")||"";
  const name=props.getProperty("INITIAL_ADMIN_NAME")||"Administrator";
  const password=props.getProperty("INITIAL_ADMIN_PASSWORD")||"";
  if(!email || !password) throw new Error("Set INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_NAME, and INITIAL_ADMIN_PASSWORD in Script Properties first.");
  const result=setupInitialAdmin(email,name,password);
  props.deleteProperty("INITIAL_ADMIN_EMAIL");
  props.deleteProperty("INITIAL_ADMIN_NAME");
  props.deleteProperty("INITIAL_ADMIN_PASSWORD");
  return result;
}

function createLoginUser_(p){const email=String(p.email||"").trim().toLowerCase(),password=String(p.password||"");if(!email||!/^\S+@\S+\.\S+$/.test(email)||password.length<12)return {ok:false,error:"Valid email and password of at least 12 characters required."};if(readSheet_("Users").some(u=>String(u.email).toLowerCase()===email))return {ok:false,error:"Email already exists."};const salt=uid_("salt")+Utilities.getUuid(),obj={id:uid_("user"),name:p.name||email.split("@")[0],email,role:["Admin","Manager","Sales","Viewer"].includes(p.role)?p.role:"Sales",passwordHash:hashPassword_(password,salt),salt,active:"TRUE",createdAt:new Date().toISOString(),lastLogin:""};appendObject_("Users",obj);audit_("CREATE_LOGIN_USER","User",obj.id,{email,role:obj.role});return {ok:true,id:obj.id};}
function login_(email,password){const e=String(email||"").trim().toLowerCase(),cache=CacheService.getScriptCache(),failKey="loginfail_"+e,attempts=Number(cache.get(failKey)||0);if(attempts>=8)return {ok:false,error:"Too many sign-in attempts. Wait 15 minutes and try again."};const users=readSheet_("Users"),u=users.find(x=>String(x.email).toLowerCase()===e);if(!u||String(u.active).toLowerCase()==="false"||u.passwordHash!==hashPassword_(String(password||""),u.salt)){cache.put(failKey,String(attempts+1),900);Utilities.sleep(250);return {ok:false,error:"Invalid email or password."};}cache.remove(failKey);CURRENT_ACTOR_ID=u.id;const token=Utilities.getUuid()+Utilities.getUuid(),session={id:u.id,name:u.name,email:u.email,role:u.role};CacheService.getScriptCache().put("sess_"+token,JSON.stringify(session),21600);updateById_("Users",u.id,{lastLogin:new Date().toISOString()});audit_("LOGIN","User",u.id,{email:u.email});return {ok:true,token,user:{id:u.id,name:u.name,email:u.email,role:u.role,permissions:permissionsFor_(u.role)}};}
function hashPassword_(password,salt){const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(salt)+"|"+String(password),Utilities.Charset.UTF_8);return bytes.map(b=>(b<0?b+256:b).toString(16).padStart(2,"0")).join("");}
function requireAuth_(token){if(!token)return {ok:false,error:"Please sign in to continue."};const raw=CacheService.getScriptCache().get("sess_"+String(token));if(!raw)return {ok:false,error:"Session expired. Please sign in again."};const user=JSON.parse(raw);const live=readSheet_("Users").find(u=>u.id===user.id&&String(u.active).toLowerCase()!=="false");if(!live)return {ok:false,error:"Account is inactive."};return {ok:true,user:live};}
function revokeSession_(token){if(token)CacheService.getScriptCache().remove("sess_"+String(token));}
function permissionsFor_(role){const all={Admin:["manage_users","manage_products","manage_sales_docs","manage_settings","view_audit","send_messages","manage_contacts","manage_followups","manage_templates","view_reports"],Manager:["manage_products","manage_sales_docs","send_messages","manage_contacts","manage_followups","manage_templates","view_reports"],Sales:["send_messages","manage_contacts","manage_followups","manage_templates","manage_sales_docs","view_reports"],Viewer:["view_reports"]};return all[role]||[];}
function hasPermission_(user,permission){return permissionsFor_(user.role).indexOf(permission)>=0;}
function setSetting_(key,value){const rows=readSheet_("Settings"),existing=rows.find(x=>x.key===key);if(existing)updateById_("Settings",existing.key,{value:value,updatedAt:new Date().toISOString()},"key");else appendObject_("Settings",{key,value,updatedAt:new Date().toISOString()});}
function installFollowupTrigger_(){ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==="processAutomatedFollowUps").forEach(t=>ScriptApp.deleteTrigger(t));ScriptApp.newTrigger("processAutomatedFollowUps").timeBased().everyHours(1).create();}
function processAutomatedFollowUps(){const enabled=readSheet_("Settings").find(x=>x.key==="FOLLOWUP_AUTOMATION");if(!enabled||enabled.value!=="TRUE")return;const now=Date.now();readSheet_("FollowUps").forEach(f=>{if(String(f.automationEnabled).toLowerCase()!=="true"||f.status==="Done"||f.status==="Sent"||!f.dueAt||new Date(f.dueAt).getTime()>now)return;const c=readSheet_("Contacts").find(x=>x.id===f.contactId);if(!c||!c.phone)return;const body=String(f.note||"Hello {{name}}, just following up.").replace(/{{name}}/g,c.name||"there");const result=sendWhatsAppMessage_(c.phone,body);appendObject_("AutomationLog",{id:uid_("auto"),followUpId:f.id,contactId:c.id,status:result.demo?"DEMO":result.ok?"SENT":"FAILED",message:result.demo?"WhatsApp credentials are not configured; no message was sent.":result.ok?body:result.error,timestamp:new Date().toISOString()});if(result.ok&&!result.demo)updateById_("FollowUps",f.id,{status:"Sent"});audit_("AUTOMATED_FOLLOWUP", "FollowUp",f.id,{result:result.demo?"DEMO":result.ok?"SENT":"FAILED"});});}

function setupSheets() {
  const id = getProp_("SPREADSHEET_ID");
  if (!id) throw new Error("Set SPREADSHEET_ID in Script Properties first.");

  const ss = SpreadsheetApp.openById(id);

  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);

    const headers = SHEETS[name];
    const oldWidth = Math.max(sh.getLastColumn(), 1);
    const first = sh.getRange(1,1,1,oldWidth).getValues()[0];
    const prefixMatches = headers.slice(0, Math.min(first.filter(String).length, headers.length)).every((h,i) => first[i] === h);
    if (sh.getLastRow() <= 1 && !first[0]) {
      sh.clear(); sh.getRange(1,1,1,headers.length).setValues([headers]);
      sh.setFrozenRows(1); sh.getRange(1,1,1,headers.length).setFontWeight("bold");
    } else if (prefixMatches) {
      // Safe schema expansion: preserve rows and append newly introduced columns.
      sh.getRange(1,1,1,headers.length).setValues([headers]);
      sh.setFrozenRows(1); sh.getRange(1,1,1,headers.length).setFontWeight("bold");
    } else {
      throw new Error("Sheet '"+name+"' has unexpected headers. Back it up and correct its header row before setup; existing data was not cleared.");
    }
  });

  seedDemoData_();

  return "Sheets ready. Core sheets initialized; sample records are seeded where configured.";
}

function seedDemoData_() {
  // Adds clearly labelled sample records only until each sheet has 10 data rows.
  // Existing records are preserved; rerunning setupSheets() will not duplicate seeded rows.
  const now = new Date();
  const iso = n => new Date(now.getTime() + n * 3600000).toISOString();
  const contacts = [
    {id:"c1",name:"Lerato Mokoena",phone:"26659000001",email:"lerato@example.com",company:"Mokoena Holdings",source:"WhatsApp",ownerId:"u2",stage:"Qualified",value:"12500",lastContact:iso(-1),notes:"SAMPLE: Interested in annual package.",createdAt:iso(-72)},
    {id:"c2",name:"Neo Trading",phone:"26659000002",email:"neo@example.com",company:"Neo Trading",source:"Website",ownerId:"u3",stage:"Proposal",value:"24000",lastContact:iso(-2),notes:"SAMPLE: Quote sent.",createdAt:iso(-68)},
    {id:"c3",name:"Khotso Media",phone:"26659000003",email:"khotso@example.com",company:"Khotso Media",source:"WhatsApp",ownerId:"u2",stage:"New",value:"7500",lastContact:iso(-3),notes:"SAMPLE: Asked for pricing.",createdAt:iso(-64)},
    {id:"c4",name:"Thaba Supplies",phone:"26659000004",email:"info@thabasupplies.example",company:"Thaba Supplies",source:"Referral",ownerId:"u4",stage:"Contacted",value:"9800",lastContact:iso(-4),notes:"SAMPLE: Requested product catalogue.",createdAt:iso(-60)},
    {id:"c5",name:"Maseru Office Hub",phone:"26659000005",email:"sales@maseruoffice.example",company:"Maseru Office Hub",source:"Website",ownerId:"u5",stage:"Qualified",value:"15700",lastContact:iso(-5),notes:"SAMPLE: Interested in office packages.",createdAt:iso(-56)},
    {id:"c6",name:"Leseli Events",phone:"26659000006",email:"hello@leselievents.example",company:"Leseli Events",source:"WhatsApp",ownerId:"u6",stage:"Proposal",value:"21200",lastContact:iso(-6),notes:"SAMPLE: Event quote requested.",createdAt:iso(-52)},
    {id:"c7",name:"Mountain View Lodge",phone:"26659000007",email:"bookings@mountainview.example",company:"Mountain View Lodge",source:"Referral",ownerId:"u7",stage:"New",value:"18900",lastContact:iso(-7),notes:"SAMPLE: Asked about service plans.",createdAt:iso(-48)},
    {id:"c8",name:"Blue Sky Retail",phone:"26659000008",email:"admin@blueskyretail.example",company:"Blue Sky Retail",source:"Facebook",ownerId:"u8",stage:"Contacted",value:"6400",lastContact:iso(-8),notes:"SAMPLE: Call back next week.",createdAt:iso(-44)},
    {id:"c9",name:"Pheko Consultants",phone:"26659000009",email:"team@pheko.example",company:"Pheko Consultants",source:"Website",ownerId:"u9",stage:"Won",value:"30500",lastContact:iso(-9),notes:"SAMPLE: Converted customer.",createdAt:iso(-40)},
    {id:"c10",name:"Kingdom Tech Services",phone:"26659000010",email:"contact@kingdomtech.example",company:"Kingdom Tech Services",source:"WhatsApp",ownerId:"u10",stage:"Lost",value:"11200",lastContact:iso(-10),notes:"SAMPLE: Opportunity closed-lost for demonstration.",createdAt:iso(-36)}
  ];
  const team = [
    {id:"u1",name:"Sales Manager",email:"manager@example.com",role:"Manager",phone:"26659000101",active:"TRUE"},
    {id:"u2",name:"Mpho Sales",email:"mpho@example.com",role:"Sales",phone:"26659000102",active:"TRUE"},
    {id:"u3",name:"Thabo Sales",email:"thabo@example.com",role:"Sales",phone:"26659000103",active:"TRUE"},
    {id:"u4",name:"Lineo Support",email:"lineo@example.com",role:"Sales",phone:"26659000104",active:"TRUE"},
    {id:"u5",name:"Teboho Mokete",email:"teboho@example.com",role:"Sales",phone:"26659000105",active:"TRUE"},
    {id:"u6",name:"Palesa Account",email:"palesa@example.com",role:"Sales",phone:"26659000106",active:"TRUE"},
    {id:"u7",name:"Kabelo Agent",email:"kabelo@example.com",role:"Sales",phone:"26659000107",active:"TRUE"},
    {id:"u8",name:"Nthane Agent",email:"nthane@example.com",role:"Sales",phone:"26659000108",active:"TRUE"},
    {id:"u9",name:"Refiloe Sales",email:"refiloe@example.com",role:"Sales",phone:"26659000109",active:"TRUE"},
    {id:"u10",name:"Boitumelo Agent",email:"boitumelo@example.com",role:"Sales",phone:"26659000110",active:"TRUE"}
  ];
  const templates = [
    {id:"t1",name:"Welcome",body:"Hi {{name}}, thanks for reaching out. How can we help you today?",category:"Lead",active:"TRUE"},
    {id:"t2",name:"Quote follow-up",body:"Hi {{name}}, just checking whether you had a chance to review our quote. I’m happy to answer any questions.",category:"Follow-up",active:"TRUE"},
    {id:"t3",name:"Appointment",body:"Hi {{name}}, your appointment is confirmed. Please let us know if anything changes.",category:"Service",active:"TRUE"},
    {id:"t4",name:"Pricing request",body:"Hi {{name}}, thanks for asking about pricing. I can share options based on your needs.",category:"Lead",active:"TRUE"},
    {id:"t5",name:"Payment options",body:"Hi {{name}}, we can explain the available payment options. Which option would you prefer to discuss?",category:"Sales",active:"TRUE"},
    {id:"t6",name:"Meeting reminder",body:"Hi {{name}}, this is a friendly reminder about our upcoming meeting. Please let us know if you need to reschedule.",category:"Service",active:"TRUE"},
    {id:"t7",name:"Thank you",body:"Hi {{name}}, thank you for your time and interest. We appreciate the opportunity to assist you.",category:"Customer care",active:"TRUE"},
    {id:"t8",name:"New product",body:"Hi {{name}}, we have new options that may suit your business. Would you like us to send details?",category:"Marketing",active:"TRUE"},
    {id:"t9",name:"Feedback request",body:"Hi {{name}}, we value your feedback. Could you share how your experience has been so far?",category:"Customer care",active:"TRUE"},
    {id:"t10",name:"Re-engagement",body:"Hi {{name}}, we’re checking in to see whether you still need assistance. We’re happy to help whenever you’re ready.",category:"Follow-up",active:"TRUE"}
  ];
  const conversations = contacts.map((c,i)=>({
    id:"v"+(i+1),contactId:c.id,phone:c.phone,contactName:c.name,ownerId:c.ownerId,
    status:i===9?"Closed":"Open",stage:c.stage,
    lastMessage:["Thanks, I will review the proposal.","Can you send the payment options?","Hello, I would like more information.","Please send the catalogue.","Can you share package details?","We need an event quotation.","Do you have service plans?","Please call me next week.","Thank you for the service.","We will not proceed at this time."][i],
    lastMessageAt:iso(-i-1),unread:String(i%3),value:c.value,createdAt:c.createdAt
  }));
  const messages = [
    ["m1","v1","c1","inbound","Hi, I saw your offer on WhatsApp.",-70,"received"],
    ["m2","v1","c1","outbound","Great! I can help. What are you looking to achieve?",-60,"sent"],
    ["m3","v1","c1","inbound","We need a solution for our sales team.",-40,"received"],
    ["m4","v1","c1","outbound","Perfect. I have prepared a proposal for you.",-30,"sent"],
    ["m5","v1","c1","inbound","Thanks, I will review the proposal.",-20,"received"],
    ["m6","v2","c2","inbound","Can you send the payment options?",-120,"received"],
    ["m7","v3","c3","inbound","Hello, I would like more information.",-300,"received"],
    ["m8","v4","c4","outbound","Thank you. I will send the catalogue shortly.",-420,"sent"],
    ["m9","v5","c5","inbound","Can you share package details?",-600,"received"],
    ["m10","v6","c6","inbound","We need an event quotation.",-720,"received"]
  ].map(m=>({id:m[0],conversationId:m[1],contactId:m[2],direction:m[3],body:"SAMPLE: "+m[4],senderId:m[3]==="outbound"?"u1":"",timestamp:iso(m[5]/60),status:m[6],waMessageId:""}));
  const followUps = contacts.map((c,i)=>({id:"f"+(i+1),contactId:c.id,conversationId:"v"+(i+1),ownerId:c.ownerId,dueAt:iso(i*6+2),note:"SAMPLE: "+["Follow up on proposal","Send payment options","Share product information","Send catalogue","Arrange a product demo","Prepare event quotation","Share service plans","Call customer back","Request customer feedback","Review closed opportunity"][i],status:i===8?"Done":"Open",createdAt:iso(-i-3)}));
  const settings = [
    ["APP_NAME","WhatsApp Sales Team CRM"],["DATA_MODE","Google Sheets"],["DEMO_DATA_ENABLED","TRUE"],
    ["WHATSAPP_API_VERSION","v23.0"],["DEFAULT_LEAD_STAGE","New"],["DEFAULT_FOLLOWUP_STATUS","Open"],
    ["DEFAULT_TEAM_ROLE","Sales"],["CURRENCY_CODE","LSL"],["TIMEZONE","Africa/Maseru"],["LAST_SEED_VERSION","2026-10-09"]
  ].map(x=>({key:x[0],value:x[1],updatedAt:now.toISOString()}));
  const audit = Array.from({length:10},(_,i)=>({id:"audit_demo_"+(i+1),actorId:"u1",action:"DEMO_SEED",recordType:["Contact","Conversation","Message","Team","Template","FollowUp","Settings","Contact","Conversation","FollowUp"][i],recordId:["c1","v1","m1","u1","t1","f1","APP_NAME","c2","v2","f2"][i],details:JSON.stringify({sample:true,description:"Initial demonstration audit entry"}),timestamp:iso(-i*24)}));
  const products=Array.from({length:10},(_,i)=>({id:"p"+(i+1),sku:"SKU-"+String(i+1).padStart(3,"0"),name:["Starter Pack","Business Plan","Premium Support","Office Bundle","WhatsApp Setup","Sales Training","Monthly Service","Product Catalogue","Consultation","Annual Package"][i],description:"SAMPLE: Demo product/service",price:[250,1200,800,2200,950,600,350,150,500,4500][i],stock:20-i,reorderLevel:5,active:"TRUE",updatedAt:now.toISOString()}));
  const rowsBySheet={Contacts:contacts,Conversations:conversations,Messages:messages,Team:team,Templates:templates,FollowUps:followUps,Settings:settings,AuditLog:audit,Products:products,Quotations:[],Invoices:[],AutomationLog:[],Users:[]};
  Object.keys(SHEETS).forEach(sheetName=>{
    if (["Users","Quotations","Invoices","AutomationLog"].includes(sheetName)) return;
    let existing=readSheet_(sheetName);
    const samples=rowsBySheet[sheetName]||[];
    for(let i=existing.length;i<10;i++){
      if(samples[i]) appendObject_(sheetName,samples[i]);
      else if(sheetName==="AuditLog") appendObject_(sheetName,{id:uid_("audit_demo"),actorId:"u1",action:"DEMO_SEED",recordType:sheetName,recordId:"",details:JSON.stringify({sample:true}),timestamp:now.toISOString()});
      else if(sheetName==="Settings") appendObject_(sheetName,{key:"SAMPLE_SETTING_"+(i+1),value:"Demo value",updatedAt:now.toISOString()});
    }
  });
}

function sendWhatsAppMessage_(to, body) {
  if (!to || !body) return {ok:false,error:"Phone number and message are required."};

  const token = getProp_("WHATSAPP_TOKEN");
  const phoneId = getProp_("WHATSAPP_PHONE_NUMBER_ID");
  const version = getProp_("WHATSAPP_API_VERSION") || "v23.0";

  if (!token || !phoneId) {
    // Demo mode keeps the UI usable before API credentials are installed.
    return {ok:true,demo:true,messageId:"demo_" + Date.now(),note:"Demo mode: WhatsApp credentials are not configured."};
  }

  const url = "https://graph.facebook.com/" + version + "/" + phoneId + "/messages";

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizePhone_(to),
    type: "text",
    text: {preview_url:false, body:body}
  };

  const response = UrlFetchApp.fetch(url, {
    method:"post",
    contentType:"application/json",
    headers:{Authorization:"Bearer " + token},
    payload:JSON.stringify(payload),
    muteHttpExceptions:true
  });

  const code = response.getResponseCode();
  const data = JSON.parse(response.getContentText() || "{}");

  if (code >= 200 && code < 300) {
    return {
      ok:true,
      messageId:data.messages && data.messages[0] ? data.messages[0].id : "",
      raw:data
    };
  }

  return {ok:false,error:(data.error && data.error.message) || response.getContentText()};
}

function processWhatsAppWebhook_(payload) {
  const entries = payload.entry || [];

  entries.forEach(entry => {
    (entry.changes || []).forEach(change => {
      const value = change.value || {};
      const messages = value.messages || [];

      messages.forEach(msg => {
        const from = msg.from || "";
        const body = extractMessageText_(msg);
        if (!body) return;

        const contact = findOrCreateContact_(from, value.contacts || []);
        const conv = findOrCreateConversation_(contact, from);

        appendObject_("Messages", {
          id: uid_("msg"),
          conversationId: conv.id,
          contactId: contact.id,
          direction: "inbound",
          body: body,
          senderId: "",
          timestamp: new Date().toISOString(),
          status: "received",
          waMessageId: msg.id || ""
        });

        updateConversation_(conv.id, {
          lastMessage: body,
          lastMessageAt: new Date().toISOString(),
          unread: String(Number(conv.unread || 0) + 1)
        });

        updateContact_(contact.id, {
          lastContact: new Date().toISOString()
        });
      });
    });
  });
}

function extractMessageText_(msg) {
  if (msg.type === "text" && msg.text) return msg.text.body || "";
  if (msg.type === "button" && msg.button) return msg.button.text || "";
  if (msg.type === "interactive" && msg.interactive) {
    if (msg.interactive.button_reply) return msg.interactive.button_reply.title || "";
    if (msg.interactive.list_reply) return msg.interactive.list_reply.title || "";
  }
  return "[" + (msg.type || "message") + "]";
}

function findOrCreateContact_(phone, contactsMeta) {
  const contacts = readSheet_("Contacts");
  const found = contacts.find(c => normalizePhone_(c.phone) === normalizePhone_(phone));
  if (found) return found;

  let name = phone;
  if (contactsMeta && contactsMeta[0] && contactsMeta[0].profile) {
    name = contactsMeta[0].profile.name || phone;
  }

  const obj = {
    id:uid_("contact"),
    name:name,
    phone:phone,
    email:"",
    company:"",
    source:"WhatsApp",
    ownerId:"",
    stage:"New",
    value:"0",
    lastContact:new Date().toISOString(),
    notes:"",
    createdAt:new Date().toISOString()
  };
  appendObject_("Contacts", obj);
  return obj;
}

function findOrCreateConversation_(contact, phone) {
  const rows = readSheet_("Conversations");
  const found = rows.find(r => normalizePhone_(r.phone) === normalizePhone_(phone) && r.status !== "Closed");
  if (found) return found;

  const obj = {
    id:uid_("conv"),
    contactId:contact.id,
    phone:phone,
    contactName:contact.name,
    ownerId:contact.ownerId || "",
    status:"Open",
    stage:contact.stage || "New",
    lastMessage:"",
    lastMessageAt:new Date().toISOString(),
    unread:"0",
    value:contact.value || "0",
    createdAt:new Date().toISOString()
  };
  appendObject_("Conversations", obj);
  return obj;
}

function updateConversation_(id, patch) {
  updateById_("Conversations", id, patch);
}

function updateContact_(id, patch) {
  updateById_("Contacts", id, patch);
}

function updateById_(sheetName, id, patch) {
  const ss = getSS_();
  const sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error("Missing sheet: " + sheetName + ". Run setupSheets() from the Apps Script editor.");
  const headers = SHEETS[sheetName];
  if (!headers) throw new Error("Unknown sheet schema: " + sheetName);
  const values = sh.getDataRange().getValues();

  for (let r=1; r<values.length; r++) {
    if (String(values[r][0]) === String(id)) {
      headers.forEach((h,c) => {
        if (Object.prototype.hasOwnProperty.call(patch,h)) {
          sh.getRange(r+1,c+1).setValue(patch[h]);
        }
      });
      return true;
    }
  }
  return false;
}

function audit_(action, recordType, recordId, details) {
  try {
    appendObject_("AuditLog", {
      id: uid_("audit"), actorId: CURRENT_ACTOR_ID || "System", action: action, recordType: recordType,
      recordId: recordId, details: JSON.stringify(details || {}),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.warn("Audit logging failed: " + err.message);
  }
}

function readSheet_(sheetName) {
  const ss = getSS_();
  const sh = ss.getSheetByName(sheetName);
  if (!sh) return [];

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0];
  return values.slice(1)
    .filter(row => row.some(v => v !== ""))
    .map(row => {
      const o = {};
      headers.forEach((h,i) => {
        let v = row[i];
        if (v instanceof Date) v = v.toISOString();
        o[h] = v;
      });
      return o;
    });
}

function appendObject_(sheetName, obj) {
  const ss = getSS_();
  const sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error("Missing sheet: " + sheetName);

  const headers = SHEETS[sheetName];
  sh.appendRow(headers.map(h => obj[h] !== undefined ? obj[h] : ""));
}

function getSS_() {
  const id = getProp_("SPREADSHEET_ID");
  if (!id) throw new Error("SPREADSHEET_ID is not configured.");
  return SpreadsheetApp.openById(id);
}

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || "";
}

function uid_(prefix) {
  return prefix + "_" + Utilities.getUuid().replace(/-/g,"").slice(0,16);
}

function normalizePhone_(phone) {
  return String(phone || "").replace(/[^\d]/g,"");
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
