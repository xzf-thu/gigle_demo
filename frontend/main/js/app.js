(() => {
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const icons = {
  plus:'<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>',
  folder:'<svg viewBox="0 0 200 150" aria-hidden="true"><path d="M14 22c0-7 5-12 12-12h44c4 0 7 1.4 9.6 4.3L90 26h84c7 0 12 5 12 12v94c0 7-5 12-12 12H26c-7 0-12-5-12-12z" fill="var(--folder-back)"/><rect x="14" y="40" width="172" height="104" rx="12" fill="var(--folder-front)"/></svg>',
  star:'<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1L3.2 9.4l6.1-.8z"/></svg>',
  dots:'<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
  x:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  web:'🌐', pdf:'📄', image:'🖼️', video:'▶️', text:'☰', websearch:'✦'
};
const formats = { slide:{label:'SLIDE',name:'Slide',desc:'网格白板上的演示内容'}, report:{label:'REPORT',name:'介绍',desc:'网格白板上的结构化介绍'}, pdf:{label:'PDF',name:'PDF',desc:'保留原始 PDF'}, blank:{label:'BOARD',name:'空白板',desc:'直接创建，无需任何来源'} };
let items = [];
const lib = { tab:'docs', folder:null, sort:'date', q:'' };
const st = { origin:null, sources:[], format:'slide', mode:'url', busy:false };
const sourceInput = $('#srcInput'), chatInput = $('#chatInput');
const errorBox = $('#srcErr');
let toastTimer;
function toast(message) { const box=$('#toast'); box.textContent=message; box.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>box.classList.remove('show'),2800); }
function error(message) { errorBox.textContent=message; errorBox.hidden=!message; if(message) toast(message); }
async function api(path, options={}) { const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}}); let data={}; try { data=await response.json(); } catch {} if(!response.ok) { const err=new Error(data.error||`请求失败 (${response.status})`); err.status=response.status; throw err; } return data; }
async function reload() { try { items=(await api('/api/library')).items; renderLibrary(); } catch (err) { $('#grid').innerHTML=`<p class="empty">${esc(err.message)}。请从本机启动器打开应用。</p>`; } }
const byId = id => items.find(item=>item.id===id);
function pathOf(id) { const path=[]; let item=byId(id); while(item) { path.unshift(item); item=byId(item.parent); } return path; }
function date(iso) { const value=new Date(iso); return Number.isNaN(value.getTime()) ? '' : value.toLocaleDateString('zh-CN'); }
function ordered(list) { return [...list].sort((a,b)=>lib.sort==='name' ? a.name.localeCompare(b.name,'zh-CN') : lib.sort==='type' ? (a.type+a.format).localeCompare(b.type+b.format) || b.date.localeCompare(a.date) : b.date.localeCompare(a.date)); }
function newTile() { return `<div class="tile"><button class="box new-box" data-new aria-label="新建项目">${icons.plus}</button><div class="label"><button class="name" data-new>新建项目</button></div></div>`; }
function folderTile(item) { return `<div class="tile"><button class="box folder-box" data-folder="${item.id}" aria-label="打开 ${esc(item.name)}">${icons.folder}</button><button class="star" data-fav="${item.id}" aria-pressed="${!!item.fav}" aria-label="收藏">${icons.star}</button><button class="more" data-menu="${item.id}" aria-label="更多操作">${icons.dots}</button><div class="label"><button class="name" data-folder="${item.id}"><span>${esc(item.name)}</span></button><span class="date">${date(item.date)}</span></div></div>`; }
function docTile(item) { const preview=item.preview||{}; const image=preview.image||item.firstImage; const photo=image&&!image.includes('/preview'); const visual=image ? `<img class="cover-image" src="${esc(image)}" alt="">` : `<div class="card-preview"><strong>${esc(preview.title||item.name)}</strong><p>${esc(preview.excerpt||'空白网格白板')}</p></div>`; return `<div class="tile"><article class="card${photo?' has-cover':''}" data-atom="${item.id}" tabindex="0" aria-label="打开 ${esc(item.name)}">${visual}<span class="fmt fmt-${item.format}"><i></i>${formats[item.format]?.label||'BOARD'}</span><button class="more" data-menu="${item.id}" aria-label="更多操作">${icons.dots}</button><div class="glass"><h3>${esc(item.name)}</h3><p>${date(item.date)} · ${item.format==='pdf'?`${item.pages||1} 页`:'白板'}</p></div></article></div>`; }
function renderLibrary() {
  document.querySelectorAll('.tabbar button').forEach(button=>button.toggleAttribute('aria-current',button.dataset.tab===lib.tab));
  document.querySelectorAll('#sortSeg button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.sort===lib.sort)));
  $('#searchField').hidden=lib.tab!=='search';
  $('#crumb').innerHTML=''; let visible=[];
  if(lib.tab==='docs') { const path=pathOf(lib.folder); $('#libTitle').textContent=path.at(-1)?.name||'文稿'; if(path.length) { const parent=path.at(-2); $('#crumb').innerHTML=`<button data-crumb="${parent?.id||''}">‹ ${esc(parent?.name||'文稿')}</button>`; } visible=items.filter(item=>item.parent===lib.folder); }
  else if(lib.tab==='search') { $('#libTitle').textContent='搜索'; const q=lib.q.trim().toLocaleLowerCase(); visible=q ? items.filter(item=>item.name.toLocaleLowerCase().includes(q)) : []; }
  else { $('#libTitle').textContent='收藏夹'; visible=items.filter(item=>item.fav); }
  $('#grid').innerHTML=(lib.tab==='docs'?newTile():'')+ordered(visible).map(item=>item.type==='folder'?folderTile(item):docTile(item)).join('')+(lib.tab!=='docs'&&!visible.length?`<p class="empty">${lib.tab==='search'?'输入名称搜索资料。':'暂无收藏。'}</p>`:'');
}
$('#grid').addEventListener('click', event=>{ const button=event.target.closest('[data-new],[data-folder],[data-atom],[data-fav],[data-menu]'); if(!button) return; if(button.hasAttribute('data-new')) return openStudio(); if(button.dataset.folder) { lib.folder=button.dataset.folder; lib.tab='docs'; renderLibrary(); return; } if(button.dataset.atom) { location.href=`/whiteboard/?atom=${encodeURIComponent(button.dataset.atom)}`; return; } if(button.dataset.fav) return toggleFavorite(button.dataset.fav); if(button.dataset.menu) { event.stopPropagation(); openMenu(button,byId(button.dataset.menu)); } });
$('#grid').addEventListener('keydown', event=>{ if(event.key==='Enter'&&event.target.matches('[data-atom]')) event.target.click(); });
$('#crumb').addEventListener('click',event=>{ const button=event.target.closest('[data-crumb]'); if(button){ lib.folder=button.dataset.crumb||null; renderLibrary(); } });
$('#sortSeg').addEventListener('click',event=>{ const button=event.target.closest('[data-sort]'); if(button){ lib.sort=button.dataset.sort; renderLibrary(); } });
$('.tabbar').addEventListener('click',event=>{ const button=event.target.closest('[data-tab]'); if(!button)return; if(button.dataset.tab==='docs'&&lib.tab==='docs')lib.folder=null; lib.tab=button.dataset.tab; renderLibrary(); if(lib.tab==='search')$('#searchInput').focus(); });
$('#searchInput').addEventListener('input',event=>{lib.q=event.target.value;renderLibrary();});
$('#newFolderBtn').addEventListener('click',async()=>{ const name=prompt('新文件夹名称'); if(!name?.trim())return; try { await api('/api/folders',{method:'POST',body:JSON.stringify({name,parent:lib.folder})}); await reload(); toast('文件夹已创建'); } catch(err){toast(err.message);} });
async function toggleFavorite(id){ const item=byId(id); try { await api(`/api/${item.type==='folder'?'folders':'atoms'}/${id}`,{method:'PATCH',body:JSON.stringify({favorite:!item.fav})}); await reload(); } catch(err){toast(err.message);} }
const menu=$('#menu');
function openMenu(anchor,item){ menu.innerHTML=`${item.type==='doc'?`<button data-action="fav">${item.fav?'取消收藏':'收藏'}</button>`:''}<button class="danger" data-action="delete">删除</button>`; menu.hidden=false; const rect=anchor.getBoundingClientRect(); menu.style.top=`${rect.bottom+6}px`; menu.style.left=`${Math.max(12,Math.min(rect.left,innerWidth-190))}px`; menu.onclick=async event=>{ const button=event.target.closest('[data-action]'); if(!button)return; if(button.dataset.action==='fav') { menu.hidden=true; return toggleFavorite(item.id); } if(!button.dataset.confirm) { button.dataset.confirm='yes'; button.textContent=`确认删除「${item.name}」`; return; } try { await api(`/api/${item.type==='folder'?'folders':'atoms'}/${item.id}`,{method:'DELETE'}); menu.hidden=true; await reload(); toast('已删除'); } catch(err){toast(err.message);} }; }
document.addEventListener('click',event=>{if(!menu.hidden&&!menu.contains(event.target))menu.hidden=true;});

function openStudio(){ st.origin=lib.folder; st.sources=[]; st.format='slide'; st.mode='url'; st.busy=false; $('#nbTitle').value=''; sourceInput.value=chatInput.value=''; const where=byId(st.origin)?.name||'文稿'; $('#backLabel').textContent=where; $('#whereLabel').textContent=where; $('#libView').hidden=true; $('#studioView').hidden=false; error(''); renderStudio(); sourceInput.focus(); }
function closeStudio(){ $('#studioView').hidden=true; $('#libView').hidden=false; lib.tab='docs'; lib.folder=st.origin; renderLibrary(); }
$('#backBtn').addEventListener('click',closeStudio);
const hasPdf=()=>st.sources.some(source=>source.kind==='pdf');
const placeholders={url:'粘贴网页链接',pdf:'粘贴 PDF 链接，或选择文件',image:'选择图片文件',video:'粘贴视频链接',text:'输入或粘贴文字',websearch:'输入要研究的问题（AI 生成，暂不联网）'};
function renderStudio(){
  const blank=st.format==='blank', locked=hasPdf(), count=st.sources.length;
  $('#nbTitle').disabled=blank; if(blank) $('#nbTitle').value='';
  $('#srcPanel').classList.toggle('disabled-panel',blank); $('.chat').classList.toggle('disabled-panel',blank);
  document.querySelectorAll('#modes button').forEach(button=>{button.setAttribute('aria-pressed',String(button.dataset.mode===st.mode));button.disabled=blank;});
  sourceInput.placeholder=placeholders[st.mode]; chatInput.placeholder=blank?'空白板无需来源':'输入链接、文字或 Web Search 问题'; sourceInput.disabled=blank||st.mode==='image'; chatInput.disabled=blank||st.mode==='image'; $('#addSrcBtn').disabled=blank; $('#drop').hidden=blank||!['pdf','image'].includes(st.mode);
  $('#srcCount').textContent=`${count} 个`; $('#chatCount').textContent=`${count} 个来源`; $('#srcEmpty').hidden=count>0;
  $('#srcList').innerHTML=st.sources.map(source=>`<li class="src-item"><span class="src-ic ic-${source.kind}">${icons[source.kind]||icons.text}</span><span class="src-meta"><b>${esc(source.name)}</b><span>${esc(source.meta||'')}</span></span><button class="rm" data-remove="${source.id}" aria-label="移除 ${esc(source.name)}">${icons.x}</button></li>`).join('');
  const option=key=>{ const item=formats[key], checked=st.format===key||locked&&key==='pdf', disabled=locked&&key!=='pdf'||blank&&key!=='blank'; return `<button class="fmt-opt" role="radio" data-format="${key}" aria-checked="${checked}" ${disabled?'disabled':''}><span class="fo-ic">${key==='blank'?'▦':key==='slide'?'▤':key==='report'?'☷':'▣'}</span><span class="fo-txt"><b>${item.name}</b><small>${item.desc}</small></span><span class="radio"></span></button>`; };
  $('#formats').innerHTML=['slide','report',...(locked?['pdf']:[]),'blank'].map(option).join(''); $('#lockNote').hidden=!locked;
  $('#createBtn').disabled=st.busy||(!blank&&!count); $('#createBtn').lastChild.textContent=st.busy?' 正在创建…':' Create Item';
  $('#srcSubmit').disabled=blank||!sourceInput.value.trim(); $('#chatSubmit').disabled=blank||!sourceInput.value.trim();
  $('#chatLog').innerHTML=`<div class="hello"><div class="wave">✦</div><h2>${blank?'空白板已就绪':'创建学习原子'}</h2><p>${blank?'直接点击 Create Item，进入白板。':'添加资料，选择 Slide 或介绍。Web Search 暂由 AI 根据已有知识生成，内容请核实。'}</p></div>`;
}
$('#modes').addEventListener('click',event=>{ const button=event.target.closest('[data-mode]'); if(!button||st.format==='blank')return; st.mode=button.dataset.mode; error(''); renderStudio(); if(['pdf','image'].includes(st.mode))$('#fileInput').click(); else sourceInput.focus(); });
$('#formats').addEventListener('click',event=>{const button=event.target.closest('[data-format]'); if(!button||button.disabled)return; const next=button.dataset.format; if(next==='blank') { st.format=st.format==='blank'?'slide':'blank'; st.sources=[]; sourceInput.value=chatInput.value=''; } else st.format=next; renderStudio();});
$('#addSrcBtn').addEventListener('click',()=>{if(st.format==='blank')return;if(['pdf','image'].includes(st.mode))$('#fileInput').click();else sourceInput.focus();});
sourceInput.addEventListener('input',()=>{chatInput.value=sourceInput.value;renderStudio();});
chatInput.addEventListener('input',()=>{sourceInput.value=chatInput.value;renderStudio();});
$('#srcForm').addEventListener('submit',event=>{event.preventDefault();submitSource();});
$('#chatForm').addEventListener('submit',event=>{event.preventDefault();submitSource();});
function addSource(source){source.id=crypto.randomUUID();st.sources.push(source);if(source.kind==='pdf')st.format='pdf'; error(''); renderStudio();}
function submitSource(){if(st.format==='blank')return;const text=sourceInput.value.trim();if(!text)return;let source;const url=/^https?:\/\/\S+$/i.test(text)?text:/^www\./i.test(text)?`https://${text}`:null;if(st.mode==='websearch')source={kind:'websearch',name:text.slice(0,40),text,meta:'AI 概述 · 未联网验证'};else if(st.mode==='text'||!url)source={kind:'text',name:text.slice(0,40),text,meta:`${text.length} 字`};else {const kind=st.mode==='pdf'||/\.pdf(?:\?|$)/i.test(url)?'pdf':st.mode==='video'?'video':'web'; source={kind,name:url.split('/').at(-1)||new URL(url).hostname,url,meta:url};}addSource(source);sourceInput.value=chatInput.value='';renderStudio();}
$('#srcList').addEventListener('click',event=>{const button=event.target.closest('[data-remove]');if(!button)return;st.sources=st.sources.filter(source=>source.id!==button.dataset.remove);if(!hasPdf()&&st.format==='pdf')st.format='slide';renderStudio();});
const fileToData=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(file);});
async function addFiles(files){if(st.format==='blank')return;for(const file of files){if(file.size>25_000_000){error(`${file.name} 超过 25 MB`);continue;}const kind=file.type==='application/pdf'||/\.pdf$/i.test(file.name)?'pdf':file.type.startsWith('image/')?'image':'file';addSource({kind,name:file.name,meta:`${Math.max(1,Math.round(file.size/1024))} KB`,data:await fileToData(file),pages:1});}}
$('#fileInput').addEventListener('change',event=>{void addFiles(event.target.files);event.target.value='';});
const panel=$('#srcPanel');panel.addEventListener('dragover',event=>{if(st.format!=='blank')event.preventDefault();});panel.addEventListener('drop',event=>{if(st.format==='blank')return;event.preventDefault();void addFiles(event.dataTransfer.files);});
$('#apiKeySave').addEventListener('click',async()=>{const key=$('#apiKeyInput').value.trim();if(!key)return;try{await api('/api/ocr/key',{method:'POST',body:JSON.stringify({key})});$('#apiKeyInput').value='';$('#apiKeyBox').hidden=true;toast('DeepSeek 已启用，请再次点击 Create');}catch(err){error(err.message);}});
$('#createBtn').addEventListener('click',async()=>{if(st.busy||st.format!=='blank'&&!st.sources.length)return;st.busy=true;renderStudio();try{const format=hasPdf()?'pdf':st.format;const title=$('#nbTitle').value.trim()||st.sources[0]?.name||'空白板';const sources=st.sources.map(({kind,name,url,text,data,pages})=>({kind,name,url,text,data,pages}));const {atom}=await api('/api/atoms',{method:'POST',body:JSON.stringify({title,format,parent:st.origin,sources})});location.href=`/whiteboard/?atom=${encodeURIComponent(atom.id)}`;}catch(err){if(err.status===401||err.status===503){$('#apiKeyBox').hidden=false;$('#apiKeyInput').focus();}error(err.message);}finally{st.busy=false;renderStudio();}});
reload();
})();
