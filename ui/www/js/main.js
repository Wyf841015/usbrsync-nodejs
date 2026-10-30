let tasks=[],devices=[],editing=-1,browseField='',currentPath='/';let browseMode='field',pendingSaveKind='';let syncStatusTimer=null;
const BASE_URL=window.location.pathname.match(/^\/app\/[^/]+/)?window.location.pathname.match(/^\/app\/[^/]+/)[0]:'';
const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,method='GET',body){const c=new AbortController(),timer=setTimeout(()=>c.abort(),15000);try{const r=await fetch(BASE_URL+path,{method,headers:{'Content-Type':'application/json'},body:body==null?undefined:JSON.stringify(body),signal:c.signal});const d=await r.json();if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d}catch(e){toast(e.name==='AbortError'?'请求超时':e.message,'error');return{success:false,error:e.message}}finally{clearTimeout(timer)}}
function toast(msg,type='info'){const e=document.createElement('div');e.className='toast '+type;e.textContent=msg;document.body.appendChild(e);setTimeout(()=>e.remove(),2800)}
function size(n){n=Number(n)||0;if(n<1024)return n+' B';const u=['KB','MB','GB','TB'];let i=-1;do{n/=1024;i++}while(n>=1024&&i<u.length-1);return n.toFixed(n<10?2:1)+' '+u[i]}
function duration(n){n=Number(n)||0;return n<60?n+'秒':Math.floor(n/60)+'分'+n%60+'秒'}
function taskPayload(t,i){return{name:t.name||'',source:t.source,target:t.target,bidirectional:!!t.bidirectional,use_delete:!!t.use_delete,task_id:t.id||'task_'+i,retry_count:+t.retry_count||0,retry_delay:+t.retry_delay||5,checksum:!!t.checksum,notify:!!t.notify,check_space:t.check_space!==false,keep_history:!!t.keep_history||!!t.keep}}
async function loadAll(){await Promise.all([loadStatus(),loadDevices(),loadTasks(),loadHistory(),loadDrives()])}
async function loadStatus(){const r=await api('/api/status');if(!r.success)return;$('status-text').textContent=r.device_count?`已连接 ${r.device_count} 个设备`:'等待 USB 设备';$('k-device').textContent=r.device_count;$('k-task').textContent=r.tasks_count;updateSyncUI(r.sync)}
async function loadDevices(){const r=await api('/api/devices');
  if(r.success===false){$('devices').innerHTML=`<div class="nd danger">设备列表加载失败：${esc(r.error||'接口错误')}</div>`;return}
  devices=r.devices||[];
  $('k-device').textContent=devices.length;
  $('k-device-sub').textContent=devices.length?`${devices.length} 个分区已挂载`:'未连接';$('devices').innerHTML=devices.length?devices.map(d=>`<div class="dc"><b>${esc(d.name||'USB')}</b><span>${esc(d.mount_point)} · ${esc(d.fs_type)} · ${size(d.size)}</span><small>UUID ${esc(d.uuid||'未知')}</small></div>`).join(''):'<div class="nd">未检测到 USB 设备</div>'}
async function loadDrives(){const r=await api('/api/drives');
  if(r.success===false){$('drives').innerHTML=`<div class="nd danger">卷信息加载失败：${esc(r.error||'接口错误')}</div>`;return}
  $('drives').innerHTML=(r.drives||[]).map(d=>{let p=d.size?Math.round((d.size-d.free)/d.size*100):0;return`<div class="drive" title="已用 ${p}%"><div><b>${esc(d.name)}</b><span>已用 ${p}% · 可用 ${size(d.free)} / ${size(d.size)}</span></div><div class="mini"><i style="width:${p}%"></i></div></div>`}).join('')||'<div class="nd">没有可用卷</div>'}
async function loadTasks(){const r=await api('/api/tasks');
  // 接口失败时不能把列表清空成「还没有同步任务」——那是把故障伪装成空数据
  if(r.success===false){if(!tasks.length)$('tasks').innerHTML=`<div class="nd danger">任务列表加载失败：${esc(r.error||'接口错误')}</div>`;return}
  tasks=r.tasks?.sync_tasks||[];tasks.forEach((t,i)=>{t.id=t.id||'task_'+Date.now()+'_'+i});renderTasks();
  const auto=tasks.filter(t=>t.auto_sync_on_insert).length, sched=tasks.filter(t=>t.schedule&&t.schedule!=='none').length;
  $('k-task').textContent=tasks.length;
  $('k-task-sub').textContent=`自动 ${auto} · 计划 ${sched}`}
async function saveTasks(){const r=await api('/api/tasks','POST',{sync_tasks:tasks,exclusions:['*.tmp','*.temp','~*','.DS_Store','Thumbs.db','System Volume Information','$RECYCLE.BIN/']});if(r.success)toast('任务已保存','success');return r.success}
function renderTasks(){$('tasks').innerHTML=tasks.length?tasks.map((t,i)=>`<article class="ti ${t.enabled===false?'disabled':''}"><div class="task-head"><div><b>${esc(t.name||'未命名任务')}</b><small>${esc(t.source||'未选择')} → ${esc(t.target||'未选择')}</small></div><span class="badge">${t.auto_sync_on_insert?'自动':'手动'}</span></div><div class="chips"><span>${t.bidirectional?'双向':'单向'}</span>${t.device_uuid?`<span>USB: ${esc(t.device_label||t.device_uuid)}</span>`:''}${t.schedule&&t.schedule!=='none'?`<span>${t.schedule==='daily'?'每天':'每周'} ${esc(t.schedule_time||'02:00')}</span>`:''}<span>重试 ${+t.retry_count||0} 次</span>${t.checksum?'<span>校验</span>':''}</div><div class="task-actions"><button class="btn bp btn-sm" onclick="runTask(${i})">同步</button><button class="btn bd btn-sm" onclick="restoreTask(${i})">恢复</button><button class="btn bs btn-sm" onclick="diffTask(${i})">对比</button><button class="btn bs btn-sm" onclick="previewTask(${i})">预览</button><button class="btn bs btn-sm" onclick="editTask(${i})">编辑</button><button class="btn bs btn-sm" onclick="copyTask(${i})">复制</button><button class="btn bd btn-sm" onclick="deleteTask(${i})">删除</button></div></article>`).join(''):'<div class="nd">还没有同步任务</div>'}
function editTask(i){editing=i;const t=i<0?{id:'task_'+Date.now(),name:'新同步任务',enabled:true,auto_sync_on_insert:false,schedule:'none',schedule_time:'02:00',retry_count:2,retry_delay:5,check_space:true,notify:true,task_exclusions:[]}:tasks[i];$('f-name').value=t.name||'';$('f-source').value=t.source||'';$('f-target').value=t.target||'';$('f-device').innerHTML='<option value="">任意设备</option>'+devices.map(d=>`<option value="${esc(d.uuid)}">${esc(d.name)} (${esc(d.uuid)})</option>`).join('');$('f-device').value=t.device_uuid||'';$('f-schedule').value=t.schedule||'none';$('f-time').value=t.schedule_time||'02:00';$('f-retry').value=t.retry_count??2;$('f-delay').value=t.retry_delay??5;$('f-exclusions').value=(t.task_exclusions||[]).join('\n');[['enabled','enabled'],['auto','auto_sync_on_insert'],['bidir','bidirectional'],['delete','use_delete'],['space','check_space'],['checksum','checksum'],['notify','notify'],['keep','keep_history']].forEach(([a,b])=>$('f-'+a).checked=t[b]!==false&&(b==='enabled'||b==='check_space'||b==='notify')?true:!!t[b]);$('task-modal').style.display='flex'}
function readEditor(){const uuid=$('f-device').value,dev=devices.find(d=>d.uuid===uuid);return{id:editing<0?'task_'+Date.now():tasks[editing].id,name:$('f-name').value.trim()||'未命名任务',source:$('f-source').value.trim(),target:$('f-target').value.trim(),enabled:$('f-enabled').checked,auto_sync_on_insert:$('f-auto').checked,bidirectional:$('f-bidir').checked,use_delete:$('f-delete').checked,device_uuid:uuid,device_label:dev?.name||'',schedule:$('f-schedule').value,schedule_time:$('f-time').value,retry_count:+$('f-retry').value||0,retry_delay:+$('f-delay').value||5,task_exclusions:$('f-exclusions').value.split('\n').map(x=>x.trim()).filter(Boolean),check_space:$('f-space').checked,checksum:$('f-checksum').checked,notify:$('f-notify').checked,keep_history:$('f-keep').checked}}
async function saveTaskEditor(){const t=readEditor();if(!t.source||!t.target){toast('请选择源目录和目标目录','error');return}editing<0?tasks.push(t):tasks.splice(editing,1,t);await saveTasks();renderTasks();closeTaskModal()}
function closeTaskModal(){$('task-modal').style.display='none'}
async function runTask(i){const t=tasks[i];if(t.device_uuid&&!devices.some(d=>d.uuid===t.device_uuid)){toast('绑定的 USB 设备未连接','error');return}const r=await api('/api/sync','POST',taskPayload(t,i));if(r.success){toast('同步已开始','success');startSyncMonitor()}}
async function previewTask(i){await showPreview(taskPayload(tasks[i],i))}async function previewEditingTask(){const t=readEditor();if(!t.source||!t.target)return toast('请先选择目录','error');await showPreview(taskPayload(t,editing))}
async function restoreTask(i){const t=tasks[i];if(!confirm(`从备份恢复?\n将 ${esc(t.target)} 恢复到 ${esc(t.source)}\n(反向 rsync, 不使用 --delete)`))return;if(t.device_uuid&&!devices.some(d=>d.uuid===t.device_uuid)){toast('绑定的 USB 设备未连接','error');return}const r=await api('/api/restore','POST',{source:t.source,target:t.target,task_id:t.id,notify:true});if(r.success){toast('恢复已开始','success');startSyncMonitor()}}
async function diffTask(i){const t=tasks[i];const r=await api('/api/diff?source='+encodeURIComponent(t.source)+'&target='+encodeURIComponent(t.target));if(!r.success)return;$('result-title').textContent='源/目标对比';const d=size(r.target_bytes-(r.source_bytes>r.target_bytes?0:r.source_bytes));$('result-summary').innerHTML=`<b>源 ${size(r.source_bytes)} / ${r.source_files} 文件</b><b>目标 ${size(r.target_bytes)} / ${r.target_files} 文件</b><b class="${r.same_size?'':'danger'}">${r.same_size?'大小一致 ✓':'有差异 (目标少 ${d})'}</b>`;$('result-content').textContent=`源目录大小: ${size(r.source_bytes)} (${r.source_files} 文件)\n目标目录大小: ${size(r.target_bytes)} (${r.target_files} 文件)\n${r.same_size?'两目录大小一致':'两目录存在差异'}`;$('result-modal').style.display='flex'}
async function showPreview(payload){$('result-title').textContent='同步预览';$('result-summary').innerHTML='正在分析变更…';$('result-content').textContent='';$('result-modal').style.display='flex';const r=await api('/api/preview','POST',payload);$('result-summary').innerHTML=r.success?`<b>新增 ${r.add}</b><b>修改 ${r.change}</b><b class="danger">删除 ${r.delete}</b>`:`<b class="danger">${esc(r.error||'预览失败')}</b>`;$('result-content').textContent=(r.lines||[]).join('\n')}
function closeResult(){$('result-modal').style.display='none'}
async function copyTask(i){const t=structuredClone(tasks[i]);t.id='task_'+Date.now();t.name+=' - 副本';tasks.splice(i+1,0,t);await saveTasks();renderTasks()}
async function deleteTask(i){if(!confirm('确定删除该任务？'))return;tasks.splice(i,1);await saveTasks();renderTasks()}
async function sortTasks(){tasks.sort((a,b)=>(a.name||'').localeCompare(b.name||'','zh-CN'));await saveTasks();renderTasks()}
function startSyncMonitor(){if(syncStatusTimer)return;syncStatusTimer=setInterval(loadSyncStatus,1500);loadSyncStatus()}
function stopSyncMonitor(){if(syncStatusTimer){clearInterval(syncStatusTimer);syncStatusTimer=null}}
async function loadSyncStatus(){const r=await api('/api/sync_status');if(!r.success)return;updateSyncUI(r.sync);if(['idle','error'].includes(r.sync.status)){const now=Date.now();if(now-(window._lastHistRefresh||0)>4000){window._lastHistRefresh=now;loadHistory()}}}
// ── 进度展示 ────────────────────────────────────────────────────
// 数据来自后端 setSyncStatus 的 extra：已传/总量、速度、ETA、文件计数、删除数
function hms(sec){sec=Math.max(0,Math.round(Number(sec)||0));const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),ss=sec%60;
  return h?`${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`:`${m}:${String(ss).padStart(2,'0')}`}
function etaText(v){if(!v)return '—';const p=String(v).split(':').reverse().map(Number);
  const sec=(p[0]||0)+(p[1]||0)*60+(p[2]||0)*3600;
  if(sec<=0)return '即将完成';
  return sec>=3600?hms(sec):(sec>=60?Math.floor(sec/60)+' 分 '+sec%60+' 秒':sec+' 秒')}
function bps(v){v=Number(v)||0;return v>0?size(v)+'/s':'—'}

function updateSyncUI(s={}){
  const el=$('sync-progress'), acts=$('prog-actions');
  if(s.status==='syncing'||s.status==='preflight'){
    const p=Math.max(0,Math.min(100,+s.progress||0));
    const done=Number(s.bytes_done)||0, tot=Number(s.bytes_total)||0;
    const elapsed=s.started_at?Math.floor(Date.now()/1000-s.started_at):0;
    const filesTotal=Number(s.files_total)||0, filesLeft=Number(s.files_left)||0;
    el.innerHTML=`<div class="progress-meta"><b>${esc(s.message||'同步中')}</b><span>${p}% ${esc(s.speed||'')}</span></div>
      <div class="progress-bar"><i style="width:${p}%"></i></div>
      <div class="prog-metrics">
        <div><span>已传输</span><b>${done?size(done):'—'}${tot?' / '+size(tot):''}</b></div>
        <div><span>瞬时速度</span><b>${esc(s.speed||'—')}</b></div>
        <div><span>已用时</span><b>${elapsed?hms(elapsed):'—'}</b></div>
        <div><span>剩余时间</span><b>${etaText(s.eta)}</b></div>
        <div><span>本次传输文件</span><b>${Number(s.files_done)||0}</b></div>
        <div><span>待检查文件</span><b>${filesTotal?(filesTotal-filesLeft)+' / '+filesTotal:'—'}</b></div>
      </div>
      <div class="current-file" title="${esc(s.current_file||'')}">${esc(s.current_file||'')}</div>`;
    acts.innerHTML=`<button class="btn bd btn-sm" onclick="stopSync()">停止同步</button>`;
  } else {
    acts.innerHTML='';
    el.innerHTML=`<div class="state ${s.status==='error'?'bad':''}">${esc(s.message||'空闲')}</div>`;
  }
}
async function stopSync(){if(!confirm('停止当前同步？'))return;await api('/api/sync_stop','POST',{});updateSyncUI({status:'idle',message:'已停止'})}
// ── 统计与历史 ──────────────────────────────────────────────────
let histFilter='all', histStats={};
function setHistFilter(f,btn){histFilter=f;
  const box=$('hist-filter');if(box)[...box.children].forEach(b=>b.classList.toggle('on',b===btn));
  drawHistory(histStats);}

function drawTrend(daily){
  const box=$('trend');if(!box)return;
  const max=Math.max(1,...daily.map(d=>d.total));
  box.innerHTML=daily.map(d=>`<div class="bar" title="${d.date} · 共 ${d.total} 次（成功 ${d.ok} / 失败 ${d.fail}）· ${size(d.bytes)}">
      <div class="bar-track"><i class="ok" style="height:${d.ok?Math.max(8,Math.round(d.ok/max*100)):0}%"></i><i class="bad" style="height:${d.fail?Math.max(8,Math.round(d.fail/max*100)):0}%"></i></div>
      <span>${d.date.slice(5)}</span><b>${d.total}</b></div>`).join('');
}

function drawTaskStats(list){
  const box=$('by-task');if(!box)return;
  if(!list.length){box.innerHTML='<div class="nd">暂无数据</div>';return}
  box.innerHTML=list.map(t=>{const rate=t.total?Math.round(t.ok/t.total*100):0;
    return `<div class="ts-row"><b title="${esc(t.task_id)}">${esc(t.task_name||t.task_id)}</b>
      <span>${t.total} 次 · 成功 ${t.ok} / 失败 ${t.fail}</span>
      <span>${size(t.bytes)}</span><span>成功率 ${rate}%</span>
      <span>均耗时 ${t.total?duration(Math.round(t.duration/t.total)):'—'}</span></div>`}).join('');
}

function drawErrors(list){
  const box=$('top-errors');if(!box)return;
  if(!list.length){box.innerHTML='<div class="nd">没有失败记录</div>';return}
  box.innerHTML=list.map((e,i)=>`<div class="err-item"><span class="rank">${i+1}</span><b>${esc(e.reason)}</b><span>${e.count} 次</span></div>`).join('');
}

function drawHistory(st){
  const box=$('history');if(!box)return;
  const all=(st.history||[]).slice().reverse();
  const list=histFilter==='ok'?all.filter(h=>h.success):histFilter==='fail'?all.filter(h=>!h.success):all;
  if(!list.length){box.innerHTML=`<div class="nd">${all.length?'当前筛选下没有记录':'暂无同步历史'}</div>`;return}
  box.innerHTML=list.map(h=>{
    const files=h.files_done??h.files??0;
    const opts=[h.use_delete?'--delete':'',h.bidirectional?'双向':'',h.checksum?'校验':''].filter(Boolean).join(' · ')||'默认';
    const tname=(h.task_name||'').trim();
    return `<div class="hist-row ${h.success?'':'fail'}" onclick="toggleHist(this)">
      <span class="status ${h.success?'ok':'bad'}">${h.success?(h.partial?'部分':'成功'):'失败'}</span>
      <div class="hist-main">
        <b class="task-name">${tname?esc(tname):esc(h.source)+' → '+esc(h.target)}</b>
        ${tname?`<em class="hist-path" title="${esc(h.source)} → ${esc(h.target)}">${esc(h.source)} → ${esc(h.target)}</em>`:''}
        <small>${new Date((h.finished_at||0)*1000).toLocaleString()} · 耗时 ${duration(h.duration)} · ${files} 文件 · ${size(h.bytes)}${h.deleted?` · 删除 ${h.deleted}`:''}${h.attempts>1?` · 尝试 ${h.attempts} 次`:''}${h.speed_bps?` · 均速 ${bps(h.speed_bps)}`:''}</small>
      </div>
      <code>${esc(h.exit_code??'-')}</code><i class="chev">▾</i>
      <div class="hist-detail">
        <div class="hd-row"><span>任务</span><b>${tname?esc(tname):'（未命名 / 旧记录）'}</b></div>
        <div class="hd-row"><span>源 → 目标</span><b>${esc(h.source)} → ${esc(h.target)}</b></div>
        <div class="hd-row"><span>结果</span><b>${esc(h.message||'')}</b></div>
        <div class="hd-row"><span>退出码</span><b>${esc(h.exit_code??'-')}${h.exit_meaning?' · '+esc(h.exit_meaning):''}</b></div>
        <div class="hd-row"><span>开始 / 结束</span><b>${new Date((h.started_at||0)*1000).toLocaleString()} → ${new Date((h.finished_at||0)*1000).toLocaleTimeString()}</b></div>
        <div class="hd-row"><span>本次需传输</span><b>${h.bytes_total?size(h.bytes_total):'—'}</b></div>
        <div class="hd-row"><span>选项</span><b>${opts}${h.keep_history?' · 保留历史':''}</b></div>
        ${h.diff_bytes!==undefined?`<div class="hd-row"><span>剩余差异</span><b>${h.synced?'0 B':'<span class="danger">'+size(h.diff_bytes)+'</span>'}</b></div>`:''}
        ${(h.errors&&h.errors.length)?`<div class="hd-errors"><span>错误</span>${h.errors.map(e=>`<code>${esc(e)}</code>`).join('')}</div>`:''}
      </div>
    </div>`}).join('');
}

function toggleHist(el){if(el)el.classList.toggle('open');}

async function loadHistory(){
  const q=histFilter==='all'?'':`?result=${histFilter}`;
  const [r,s]=await Promise.all([api('/api/history'+q),api('/api/stats')]);
  // 统计接口失败时不要把 KPI 覆盖成 0（看起来像"从未成功"）
  if(s.success!==false){
    $('k-success').textContent=s.ok||0;
    $('k-fail').textContent=s.fail||0;
    // 有失败时给失败卡加警示色（0 失败时不加，避免视觉噪声）
    const failCard=$('k-fail').closest('article');
    if(failCard)failCard.classList.toggle('is-bad',(s.fail||0)>0);
    $('k-bytes').textContent=size(s.bytes);
    $('k-speed').textContent=s.avg_speed?size(s.avg_speed)+'/s':'—';
    $('k-success-sub').textContent=`成功率 ${s.success_rate??0}%`;
    $('k-fail-sub').textContent=`近 24h ${s.last24h?s.last24h.fail:0} 次失败`;
    $('k-bytes-sub').textContent=`近 24h ${size(s.last24h?s.last24h.bytes:0)}`;
    $('k-speed-sub').textContent=`均耗时 ${s.avg_duration?duration(s.avg_duration):'—'}`;
    if(s.daily)drawTrend(s.daily);
    if(s.top_errors)drawErrors(s.top_errors);
    if(s.by_task)drawTaskStats(s.by_task);
  }
  if(r.success===false){
    $('history').innerHTML=`<div class="nd danger">历史记录加载失败：${esc(r.error||'接口错误')}</div>`;
    return;
  }
  histStats={history:r.history||[]};
  drawHistory(histStats);
  $('hist-count').textContent=`共 ${r.total??(r.history||[]).length} 次`;
}
async function clearHistory(){if(!confirm('清空全部同步历史？'))return;await api('/api/history?action=clear','POST',{});loadHistory()}
// ── 目录浏览 ──────────────────────────────────────────────────
// 源目录只允许在 USB 设备内浏览：browseRoot 锁住设备挂载点，界面上没有
// "返回上级"能走到 /vol1、/mnt 这些本机卷；后端 /api/browse?root= 再校验一次。
// 目标目录仍可在允许的卷内自由浏览。
let browseRoot='', browseUsbOnly=false;
const FOLDER_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;margin-right:8px"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';

function deviceByUuid(uuid){return devices.find(d=>d.uuid===uuid)||null}
function encPath(p){return encodeURIComponent(p)}

function openBrowse(field){
  browseMode='field'; browseField=field; browseRoot='';
  // 只有「源目录 + 已绑定具体设备」才锁范围；选「任意设备」时可浏览所有目录
  const boundDev = field==='source' ? deviceByUuid($('f-device').value) : null;
  browseUsbOnly = !!boundDev;
  $('browse-confirm').disabled = false;
  $('browse-confirm').textContent = '选择当前目录';
  $('browse-title').textContent = field!=='source' ? '选择目标目录'
    : (boundDev ? `选择 ${boundDev.label||boundDev.name||'USB'} 内的源目录` : '选择源目录（任意设备）');
  $('browse-modal').style.display='flex';
  if (browseUsbOnly){                              // 绑定设备：锁在该设备内
    browseRoot = boundDev.mount_point;
    const cur = $('f-source').value || '';
    const start = (cur===browseRoot || cur.startsWith(browseRoot+'/')) ? cur : browseRoot;
    return loadBrowse(encPath(start), encPath(browseRoot));
  }
  currentPath = $('f-'+field).value || '/vol1';    // 任意设备：整机允许范围自由浏览
  loadBrowse(encPath(currentPath));
}

async function loadBrowse(encPathArg, encRootArg){
  const path = decodeURIComponent(encPathArg);
  const root = encRootArg!==undefined ? decodeURIComponent(encRootArg) : browseRoot;
  const r = await api('/api/browse?path='+encPath(path)+(root?'&root='+encPath(root):''));
  if (!r.success){
    // 读取失败时清掉旧列表与旧路径：否则会残留上一次的目录列表，
    // 看着还能选，确认下去却是个无效路径（绑定的设备被拔掉时就会这样）
    toast(r.error||'无法读取该目录','error');
    currentPath='';
    $('browse-path').textContent = '无法读取该目录';
    $('browse-confirm').disabled = true;
    $('browse-list').innerHTML = '<div class="nd">该目录不可访问，请重新选择</div>';
    return;
  }
  currentPath = r.path; browseRoot = root||''; 
  $('browse-path').textContent = r.path;
  $('browse-confirm').disabled = false;

  const items = [];
  // 到了设备根目录就不再提供"返回上级"，避免走进本机卷
  const atRoot = browseRoot && currentPath === browseRoot;
  if (!atRoot && currentPath !== '/')
    items.push(`<button class="browse-item" onclick="loadBrowse('${encPath(currentPath.replace(/\/$/,'').split('/').slice(0,-1).join('/')||'/')}')">↑ 返回上级</button>`);

  for (const x of (r.entries||[]).filter(e=>e.type==='dir'))
    items.push(`<button class="browse-item" onclick="loadBrowse('${encPath((currentPath==='/'?'':currentPath)+'/'+x.name)}')">${FOLDER_SVG}<span>${esc(x.name)}</span></button>`);

  $('browse-list').innerHTML = items.join('') || '<div class="nd">该目录下没有子目录</div>';
}

function confirmBrowse(){
  if (browseMode==='save'){ const dir=currentPath; closeBrowse(); savePendingTo(dir); return; }
  if (browseUsbOnly && !currentPath){ toast('请先选择一个 USB 设备目录','error'); return; }
  if (browseUsbOnly && browseRoot && currentPath!==browseRoot && !currentPath.startsWith(browseRoot+'/')){
    toast('源目录必须在所选 USB 设备内','error'); return;
  }
  $('f-'+browseField).value = currentPath;
  closeBrowse();
}

// 绑定设备变化：源目录若不在新设备里就清空，避免留下跨设备的无效路径
function onDeviceBindingChange(){
  const dev = deviceByUuid($('f-device').value);
  const src = ($('f-source').value||'').trim();
  if (!dev || !src) return;
  if (src !== dev.mount_point && !src.startsWith(dev.mount_point + '/')){
    $('f-source').value = '';
    toast('源目录已清空：需在新绑定的 USB 设备内重新选择','error');
  }
}

// 导出/下载日志: 先弹目录选择器, 再由用户指定保存位置(不再落到浏览器默认下载目录)
function openSaveBrowse(kind){browseMode='save';pendingSaveKind=kind;
  $('browse-title').textContent=kind==='log'?'选择日志保存目录':'选择配置保存目录';
  $('browse-confirm').textContent=kind==='log'?'保存到此处':'保存到此处';
  currentPath='/vol1/1000';$('browse-modal').style.display='flex';
  loadBrowse(encodeURIComponent(currentPath));}
async function savePendingTo(dir){
  try{
    let r;
    if(pendingSaveKind==='log'){
      r=await api('/api/save_file','POST',{dir,kind:'log',content:$('result-content').textContent});
    }else{
      r=await api('/api/save_file','POST',{dir,kind:'config'});
    }
    if(r.success){toast('已保存到 '+r.path,'success');}
    else{toast(r.error||'保存失败','error');}
  }catch(e){toast(e.message,'error');}
}function closeBrowse(){$('browse-modal').style.display='none'}
async function showLogs(){const r=await api('/api/log?lines=500');$('result-title').textContent='同步日志';$('result-summary').innerHTML=`<b>${r.lines||0} 行</b><button class="btn bs btn-sm" onclick="downloadLogs()">下载日志</button>`;$('result-content').textContent=(r.log||[]).join('\n');$('result-modal').style.display='flex'}
function downloadLogs(){openSaveBrowse('log')}
async function exportConfig(){openSaveBrowse('config')}
async function importConfig(input){const f=input.files[0];if(!f)return;try{const cfg=JSON.parse(await f.text());if(!Array.isArray(cfg.sync_tasks))throw new Error('配置格式错误');const r=await api('/api/config_import','POST',cfg);if(r.success){toast('配置已导入','success');loadTasks()}}catch(e){toast(e.message,'error')}input.value=''}
// ── 主题切换 ──
const THEME_KEY='usbrsync-dark';
const THEME_ICON={moon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13.5A8 8 0 0 1 10.5 4a8 8 0 1 0 9.5 9.5Z"/></svg>',sun:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>'};
  function applyTheme(dark){document.documentElement.classList.toggle('dark',dark);const ic=document.getElementById('themeIcon'),lb=document.getElementById('themeLabel');if(ic)ic.innerHTML=dark?THEME_ICON.sun:THEME_ICON.moon;if(lb)lb.textContent=dark?'浅色':'主题';const bt=document.getElementById('themeBtn');if(bt)bt.title=dark?'切换到深色主题':'切换到浅色主题'}
function toggleTheme(){const dark=!document.documentElement.classList.contains('dark');applyTheme(dark);try{localStorage.setItem(THEME_KEY,dark?'1':'0')}catch(e){}}
function initTheme(){let dark=false;try{dark=localStorage.getItem(THEME_KEY)==='1'}catch(e){}applyTheme(dark)}
// ── 赞助 ──
function showContactModal(){const o=document.getElementById('contactModal');if(o){o.classList.add('show');const n=document.getElementById('qqNumber');if(n){n.textContent='745565752';n.style.color='';}}}
// 复制 QQ 群号: clipboard -> execCommand(带 focus, CEF 必需) -> 手动选中
// 每一级都给出可见反馈, 绝不静默失败 (fnOS WebView 走 http 时 clipboard 为 undefined)
function copyQQNumber(){
  const qq='745565752',el=$('qqNumber');
  const feedback=ok=>{if(!el)return;const orig=el.textContent;
    el.textContent=ok?'✓ 已复制':'复制失败,请长按选中后手动复制';
    el.style.color=ok?'var(--green)':'var(--gold)';
    setTimeout(()=>{el.textContent=orig;el.style.color='';},2000);};
  const manual=()=>{try{if(el){const r=document.createRange();r.selectNodeContents(el);
    const sel=window.getSelection&&window.getSelection();if(sel){sel.removeAllRanges();sel.addRange(r);}}}catch(e){}feedback(false);};
  const exec=()=>{let ta=null;
    try{ta=document.getElementById('__qqCopyTa');
      if(!ta){ta=document.createElement('textarea');ta.id='__qqCopyTa';ta.value=qq;ta.setAttribute('readonly','');
        ta.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:99999';
        document.body.appendChild(ta);}
      ta.focus();ta.select();ta.setSelectionRange(0,qq.length);
      if(document.execCommand('copy')){ta.remove();return feedback(true);}}catch(e){}
    if(ta&&ta.remove){try{ta.remove();}catch(e){}}manual();};
  try{if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(qq).then(()=>feedback(true)).catch(exec);}else{exec();}}
  catch(e){exec();}
}
function showSponsorModal(){const o=document.getElementById('sponsorModal');if(o)o.classList.add('show')}
function showSponsorImgFull(img){const o=document.getElementById('sponsorImgOverlay');if(o){o.classList.add('show');document.getElementById('sponsorImgFull').src=img.src}}
window.onload=async function(){initTheme();await loadAll();const dv=document.getElementById('f-device');if(dv)dv.addEventListener('change',onDeviceBindingChange);window._lastHistRefresh=Date.now();startSyncMonitor()};