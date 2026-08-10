// Статика + прокси парсера + прокси ИИ (ключи в env) + учёт usage + пароль на вход.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");

const PARSER_BASE = process.env.PARSER_BASE || "https://api.parser.digitalocean.mooonai.com";
const PARSER_API_KEY = process.env.PARSER_API_KEY || "";
const TWOGIS_API_KEY = process.env.TWOGIS_API_KEY || ""; // ключ официального Catalog API 2ГИС (наш парсер)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8", ".svg":"image/svg+xml", ".ico":"image/x-icon", ".png":"image/png" };

const PARSER_PATHS = { website:"/api/v1/parsers/general", "2gis":"/api/v1/parsers/2gis", instagram:"/api/v1/parsers/instagram/profile" };

// $ за 1M токенов [input, output]
const PRICES = {
  "claude-sonnet-5":[3,15], "claude-opus-5":[15,75], "claude-haiku-4-5-20251001":[1,5], "claude-sonnet-4-5-20250929":[3,15],
  "gpt-4o":[2.5,10], "gpt-4o-mini":[0.15,0.6], "gpt-4.1":[2,8]
};
function priceFor(model){ return PRICES[model] || [3,15]; }

/* ---------- usage store ---------- */
let usage = { totals:{input:0,output:0,cost:0,requests:0}, bySection:{}, byModel:{}, parseRequests:0, updatedAt:null };
function loadUsage(){ try{ fs.mkdirSync(DATA_DIR,{recursive:true}); if(fs.existsSync(USAGE_FILE)) usage=JSON.parse(fs.readFileSync(USAGE_FILE,"utf8")); }catch(e){ console.error("usage load:",e.message); } }
function saveUsage(){ try{ fs.mkdirSync(DATA_DIR,{recursive:true}); fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); }catch(e){ console.error("usage save:",e.message); } }
function bump(bucket,key,inp,out,cost){ if(!bucket[key]) bucket[key]={input:0,output:0,cost:0,requests:0}; const b=bucket[key]; b.input+=inp;b.output+=out;b.cost+=cost;b.requests+=1; }
function recordUsage(section,model,inp,out){
  const [pi,po]=priceFor(model); const cost=(inp/1e6)*pi+(out/1e6)*po;
  usage.totals.input+=inp; usage.totals.output+=out; usage.totals.cost+=cost; usage.totals.requests+=1;
  bump(usage.bySection, section||"other", inp,out,cost);
  bump(usage.byModel, model||"unknown", inp,out,cost);
  usage.updatedAt=new Date().toISOString(); saveUsage();
}
loadUsage();

let TG_USERNAME="";
if(TELEGRAM_BOT_TOKEN){ tgApi("getMe").then(j=>{ if(j&&j.ok) TG_USERNAME=j.result.username; }).catch(()=>{}); }

/* ---------- helpers ---------- */
function sendJson(res,code,obj){ res.writeHead(code,{ "content-type":MIME[".json"] }); res.end(JSON.stringify(obj)); }
function readBody(req){ return new Promise((resolve)=>{ let b=""; req.on("data",c=>{ b+=c; if(b.length>12e6) req.destroy(); }); req.on("end",()=>resolve(b)); }); }

/* ---------- Telegram ---------- */
async function tgApi(method,payload){
  const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload||{})});
  return r.json();
}
async function handleTgLink(req,res){
  if(!TELEGRAM_BOT_TOKEN) return sendJson(res,500,{ok:false,error:"TELEGRAM_BOT_TOKEN не задан на сервере"});
  const j=await tgApi("getUpdates",{limit:30,timeout:0});
  if(!j.ok) return sendJson(res,502,{ok:false,error:j.description||"getUpdates error"});
  let chat=null;
  (j.result||[]).forEach(u=>{const m=u.message||u.edited_message||u.channel_post; if(m&&m.chat&&(m.chat.type==="private"||m.chat.type==="group"||m.chat.type==="supergroup")){chat={chat_id:m.chat.id,name:[m.chat.first_name,m.chat.last_name].filter(Boolean).join(" ")||m.chat.title||m.chat.username||("id"+m.chat.id)};}});
  if(!chat) return sendJson(res,200,{ok:false,error:"Пока не вижу сообщений боту. Напишите боту /start и нажмите «Проверить связь» ещё раз."});
  return sendJson(res,200,{ok:true,chat});
}
async function handleTgSend(req,res){
  if(!TELEGRAM_BOT_TOKEN) return sendJson(res,500,{ok:false,error:"TELEGRAM_BOT_TOKEN не задан"});
  const b=await readBody(req); let d={}; try{d=JSON.parse(b||"{}");}catch(e){}
  if(!d.chat_id) return sendJson(res,400,{ok:false,error:"нет chat_id"});
  const j=await tgApi("sendMessage",{chat_id:d.chat_id,text:(d.text||"").slice(0,4000),parse_mode:"HTML"});
  return sendJson(res,j.ok?200:502,{ok:!!j.ok,error:j.description});
}

/* ---------- извлечение текста из файла (PDF и т.п.) ---------- */
async function handleExtract(req,res){
  const b=await readBody(req); let d={}; try{ d=JSON.parse(b||"{}"); }catch(e){ return sendJson(res,400,{ok:false,error:"bad json"}); }
  if(!d.base64) return sendJson(res,400,{ok:false,error:"нет файла"});
  const name=(d.name||"").toLowerCase();
  try{
    const buf=Buffer.from(d.base64,"base64");
    if(name.endsWith(".pdf")){
      try{
        const { extractText, getDocumentProxy } = await import("unpdf");
        const pdf=await getDocumentProxy(new Uint8Array(buf));
        const out=await extractText(pdf,{mergePages:true});
        const text=(Array.isArray(out.text)?out.text.join("\n"):(out.text||"")).replace(/\n{3,}/g,"\n\n").trim();
        if(!text) return sendJson(res,200,{ok:false,error:"в PDF не найден текст (возможно, это скан)"});
        return sendJson(res,200,{ok:true,text:text.slice(0,20000)});
      }catch(e){ return sendJson(res,502,{ok:false,error:"Не удалось прочитать PDF: "+(e.message||e)}); }
    }
    return sendJson(res,200,{ok:true,text:buf.toString("utf8").slice(0,20000)});
  }catch(e){ return sendJson(res,502,{ok:false,error:"Не удалось прочитать файл: "+(e.message||e)}); }
}

/* ---------- транскрипция аудио (Whisper) ---------- */
async function handleTranscribe(req,res){
  if(!OPENAI_API_KEY) return sendJson(res,500,{ok:false,error:"OPENAI_API_KEY не задан на сервере"});
  const b=await readBody(req); let d={}; try{d=JSON.parse(b||"{}");}catch(e){return sendJson(res,400,{ok:false,error:"bad json"});}
  if(!d.audio_base64) return sendJson(res,400,{ok:false,error:"нет аудио"});
  try{
    const buf=Buffer.from(d.audio_base64,"base64");
    const fd=new FormData();
    fd.append("file",new Blob([buf],{type:d.mime||"audio/webm"}),"audio.webm");
    fd.append("model","whisper-1");
    if(d.lang) fd.append("language",d.lang);
    const r=await fetch("https://api.openai.com/v1/audio/transcriptions",{method:"POST",headers:{authorization:"Bearer "+OPENAI_API_KEY},body:fd});
    const j=await r.json();
    if(!r.ok) return sendJson(res,502,{ok:false,error:(j.error&&j.error.message)||"whisper error"});
    return sendJson(res,200,{ok:true,text:j.text||""});
  }catch(e){return sendJson(res,502,{ok:false,error:String(e.message||e)});}
}
function authed(req){ if(!SITE_PASSWORD) return true; return (req.headers["x-site-pass"]||"")===SITE_PASSWORD; }
function htmlToText(html){ if(!html) return ""; return html
  .replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<noscript[\s\S]*?<\/noscript>/gi," ")
  .replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/\s+/g," ").trim().slice(0,15000); }

/* ---------- свой парсер 2ГИС через официальный Catalog API ---------- */
function extract2gisId(url){
  const m=(url||"").match(/\/firm\/(\d+)/)||(url||"").match(/\/geo\/(\d+)/)||(url||"").match(/(\d{10,})/);
  return m?m[1]:null;
}
function summarizeSchedule(s){
  if(!s) return null;
  if(s.is_24x7) return "круглосуточно";
  const days={Mon:"Пн",Tue:"Вт",Wed:"Ср",Thu:"Чт",Fri:"Пт",Sat:"Сб",Sun:"Вс"};
  const parts=[];
  Object.keys(days).forEach(k=>{ const d=s[k]; if(d&&Array.isArray(d.working_hours)&&d.working_hours.length){ parts.push(`${days[k]} ${d.working_hours.map(w=>`${w.from}–${w.to}`).join(",")}`); } });
  return parts.join("; ")||null;
}
async function parse2gisOwn(url){
  const id=extract2gisId(url);
  if(!id) throw new Error("не удалось определить id фирмы из ссылки 2ГИС");
  const fields="items.point,items.address,items.schedule,items.contact_groups,items.rubrics,items.name_ex,items.description";
  const api=`https://catalog.api.2gis.com/3.0/items/byid?id=${id}&key=${TWOGIS_API_KEY}&fields=${encodeURIComponent(fields)}&locale=ru_KZ`;
  const r=await fetch(api); const j=await r.json();
  const item=j&&j.result&&Array.isArray(j.result.items)&&j.result.items[0];
  if(!item) throw new Error("фирма не найдена в 2ГИС ("+((j&&j.meta&&j.meta.error&&j.meta.error.message)||"нет данных")+")");
  let phone=null;
  (item.contact_groups||[]).forEach(g=>(g.contacts||[]).forEach(c=>{ if(!phone&&c.type==="phone") phone=c.text||c.value; }));
  return { source:"2gis", parsed_at:new Date().toISOString(),
    company_name:item.name||(item.name_ex&&item.name_ex.primary)||null,
    company_category:(item.rubrics&&item.rubrics[0]&&item.rubrics[0].name)||null,
    company_address:item.address_name||(item.address&&item.address.name)||null,
    branches_count:null, working_hours:summarizeSchedule(item.schedule),
    phone_number:phone||null, error:null };
}

/* ---------- /api/parse ---------- */
async function handleParse(req,res){
  const body=await readBody(req); let p={}; try{ p=JSON.parse(body||"{}"); }catch(e){ return sendJson(res,400,{ok:false,error:"Некорректный JSON"}); }
  // свой парсер 2ГИС (если задан ключ) — с фолбэком на MoonAI
  if(p.type==="2gis" && TWOGIS_API_KEY && p.url){
    try{ const data=await parse2gisOwn(p.url); usage.parseRequests+=1; saveUsage(); return sendJson(res,200,{ok:true,type:"2gis",engine:"own",data}); }
    catch(e){ console.error("2gis own failed, fallback:",e.message); }
  }
  const apiPath=PARSER_PATHS[p.type];
  if(!apiPath) return sendJson(res,400,{ok:false,error:"Неизвестный тип источника"});
  if(!p.url) return sendJson(res,400,{ok:false,error:"Не передан url"});
  if(!PARSER_API_KEY) return sendJson(res,500,{ok:false,error:"PARSER_API_KEY не задан"});
  // ретраи: Instagram/сайты бывают флапают из-за анти-бота
  const attempts = p.type==="instagram" ? 3 : 2;
  let lastErr="";
  for(let a=0;a<attempts;a++){
    try{
      if(a>0) await new Promise(r=>setTimeout(r,1500));
      const r=await fetch(`${PARSER_BASE}${apiPath}?url=${encodeURIComponent(p.url)}`,{ method:"POST", headers:{ Authorization:PARSER_API_KEY, accept:"application/json" } });
      const txt=await r.text(); let data; try{ data=JSON.parse(txt); }catch(e){ data={raw:txt}; }
      if(!r.ok){ lastErr=`парсер вернул ${r.status}`; continue; }
      if(data && data.error){ lastErr=String(data.error); continue; }
      if(p.type==="instagram" && !(data && data.ig_username)){ lastErr="instagram: пусто"; continue; }
      if(p.type==="2gis" && !(data && data.company_name)){ lastErr="2gis: пусто"; continue; }
      usage.parseRequests+=1; saveUsage();
      if(p.type==="website"&&data&&typeof data.html==="string") data={source:data.source,url:data.url,text:htmlToText(data.html),error:data.error};
      return sendJson(res,200,{ok:true,type:p.type,data});
    }catch(err){ lastErr=err.message||String(err); }
  }
  usage.parseRequests+=1; saveUsage();
  return sendJson(res,502,{ok:false,error:"Не удалось получить данные ("+lastErr+")"});
}

/* ---------- /api/llm (прокси к провайдеру, ключи из env) ---------- */
async function handleLLM(req,res){
  const provider=(req.headers["x-provider"]||"anthropic");
  const section=(req.headers["x-section"]||"other");
  const body=await readBody(req); let payload; try{ payload=JSON.parse(body||"{}"); }catch(e){ return sendJson(res,400,{error:{message:"Некорректный JSON"}}); }
  const model=payload.model||"";
  try{
    let url,headers;
    if(provider==="anthropic"){
      if(!ANTHROPIC_API_KEY) return sendJson(res,500,{error:{message:"ANTHROPIC_API_KEY не задан на сервере"}});
      url="https://api.anthropic.com/v1/messages";
      headers={ "content-type":"application/json","x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01" };
    }else{
      if(!OPENAI_API_KEY) return sendJson(res,500,{error:{message:"OPENAI_API_KEY не задан на сервере"}});
      url="https://api.openai.com/v1/chat/completions";
      headers={ "content-type":"application/json","authorization":"Bearer "+OPENAI_API_KEY };
    }
    const r=await fetch(url,{ method:"POST", headers, body:JSON.stringify(payload) });
    const txt=await r.text(); let data; try{ data=JSON.parse(txt); }catch(e){ data=null; }
    if(r.ok && data && data.usage){
      const u=data.usage;
      const inp=u.input_tokens ?? u.prompt_tokens ?? 0;
      const out=u.output_tokens ?? u.completion_tokens ?? 0;
      recordUsage(section, model, inp, out);
    }
    res.writeHead(r.status,{ "content-type":MIME[".json"] }); res.end(txt);
  }catch(err){ return sendJson(res,502,{error:{message:"Ошибка запроса к провайдеру: "+(err.message||err)}}); }
}

/* ---------- server ---------- */
http.createServer(async (req,res)=>{
  const p=(req.url||"/").split("?")[0];

  if(p==="/api/health"){ return sendJson(res,200,{ ok:true, parser_key:!!PARSER_API_KEY, needs_auth:!!SITE_PASSWORD,
    twogis_own:!!TWOGIS_API_KEY, telegram:!!TELEGRAM_BOT_TOKEN, telegram_bot:TG_USERNAME, keys:{ openai:!!OPENAI_API_KEY, anthropic:!!ANTHROPIC_API_KEY } }); }

  if(req.method==="POST" && p==="/api/login"){
    const b=await readBody(req); let d={}; try{ d=JSON.parse(b||"{}"); }catch(e){}
    return sendJson(res,200,{ ok: !SITE_PASSWORD || d.password===SITE_PASSWORD });
  }

  // защищённые эндпоинты
  if(p.startsWith("/api/")){
    if(!authed(req)) return sendJson(res,401,{ ok:false, error:"Требуется вход" });
    if(req.method==="POST" && p==="/api/parse") return handleParse(req,res);
    if(req.method==="POST" && p==="/api/llm") return handleLLM(req,res);
    if(p==="/api/usage") return sendJson(res,200,{ ok:true, usage });
    if(req.method==="POST" && p==="/api/telegram/link") return handleTgLink(req,res);
    if(req.method==="POST" && p==="/api/telegram/send") return handleTgSend(req,res);
    if(req.method==="POST" && p==="/api/transcribe") return handleTranscribe(req,res);
    if(req.method==="POST" && p==="/api/extract") return handleExtract(req,res);
    return sendJson(res,404,{ ok:false, error:"unknown endpoint" });
  }

  // статика
  let urlPath=decodeURIComponent(p); if(urlPath==="/") urlPath="/index.html";
  const filePath=path.normalize(path.join(ROOT,urlPath));
  if(!filePath.startsWith(ROOT)){ res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath,(err,data)=>{
    if(err){ return fs.readFile(path.join(ROOT,"index.html"),(e2,home)=>{ if(e2){ res.writeHead(404); return res.end("Not found"); } res.writeHead(200,{ "content-type":MIME[".html"] }); res.end(home); }); }
    const ext=path.extname(filePath).toLowerCase(); res.writeHead(200,{ "content-type":MIME[ext]||"application/octet-stream" }); res.end(data);
  });
}).listen(PORT,()=>console.log(`onboarding-agent listening on :${PORT}`));
