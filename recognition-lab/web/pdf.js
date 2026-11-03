/* PDF import, saved jobs and navigation; graph exploration remains in app.js. */
(() => {
  const el = id => document.getElementById(id);
  const terminal = state => ['complete','partial','cancelled','failed','interrupted'].includes(state);
  const useful = graph => ['estimated_coordinates','qualitative_description'].includes(graph.recognition);
  const resumable = data => typeof data.can_resume === 'boolean' ? data.can_resume : ['partial','cancelled','failed','interrupted'].includes(data.state) && data.pages_done < data.pages_total;
  let jobId=null, manifest=null, pollTimer=null, loadGeneration=0, signature='';
  let selectionTouched=false, autoOpenPending=false, preflight=null, preflightTask=null, previewGeneration=0;
  let settings={upload_limit_mb:20,batch_pages:100}, settingsKnown=false;
  let starting=false, jobRunning=false;
  function status(text) { if(el('pdf-status').textContent!==text)el('pdf-status').textContent=text; }
  function active() { return starting || jobRunning; }
  async function request(path, options={}) {
    const tokenResponse=await fetch('/token');
    if(!tokenResponse.ok){const error=Error('The recognizer is not responding.');error.status=tokenResponse.status;throw error;}
    const {token}=await tokenResponse.json();
    const response=await fetch(path,{...options,headers:{...options.headers,'X-Local-Token':token}});
    if(!response.ok){
      let data={};try{data=await response.json();}catch(_){}
      const error=Error(data.error||'PDF request failed.');error.status=response.status;throw error;
    }
    return response;
  }
  function option(value,label){const item=document.createElement('option');item.value=String(value);item.textContent=label;return item;}
  function list(id,items){el(id).replaceChildren(...items.map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));}
  function invalidateSelection(manual=true){++loadGeneration;if(manual)selectionTouched=true;el('pdf-selection').textContent='';}
  window.PdfReaderUI={invalidateSelection};
  function applySettings(data){
    settings={upload_limit_mb:Number(data.upload_limit_mb),batch_pages:Number(data.batch_pages)};settingsKnown=true;
    el('settings-upload-limit').value=String(settings.upload_limit_mb);el('settings-batch-pages').value=String(settings.batch_pages);
    el('pdf-limit').textContent=`(up to ${settings.upload_limit_mb} MB)`;
    el('pdf-range-help').textContent=`Pages run in batches of up to ${settings.batch_pages}. Leave the last page blank for the end. Use PDF page numbers.`;
    preflight=null;
  }
  const settingsReady=(async()=>{
    try{applySettings(await(await request('/settings')).json());}
    catch(error){el('settings-status').textContent='Settings could not be loaded. '+error.message;}
  })();
  function selectedRange(){
    const first=Number(el('pdf-first').value),last=el('pdf-last').value?Number(el('pdf-last').value):null;
    if(!Number.isInteger(first)||first<1||(last!==null&&(!Number.isInteger(last)||last<first)))throw Error('Choose valid first and last PDF pages.');
    return {first,last};
  }
  function rangeHeaders(range){return {'X-PDF-First-Page':String(range.first),'X-PDF-Last-Page':range.last===null?'':String(range.last)};}
  function fileKey(file,range){return {file,key:`${range.first}/${range.last}/${settings.upload_limit_mb}/${settings.batch_pages}`};}
  async function inspectFile(file){
    await settingsReady;
    if(settingsKnown&&file.size>settings.upload_limit_mb*1024*1024)throw Error(`Choose a PDF up to ${settings.upload_limit_mb} MB, or change the limit in Settings.`);
    const range=selectedRange(),key=fileKey(file,range);
    if(preflight?.file===file&&preflight.key===key.key)return preflight.data;
    if(preflightTask?.file===file&&preflightTask.key===key.key)return preflightTask.promise;
    const task={...key};
    task.promise=(async()=>{
      const data=await(await request('/pdf-inspect',{method:'POST',body:file,headers:{...rangeHeaders(range),'X-PDF-Name':encodeURIComponent(file.name||'document.pdf')}})).json();
      if(preflightTask===task)preflight={...key,data};
      return data;
    })();
    preflightTask=task;
    try{return await task.promise;}finally{if(preflightTask===task)preflightTask=null;}
  }
  function describePreflight(data){
    const batches=Array.isArray(data.batches)?data.batches.length:Math.ceil(data.pages_total/data.batch_pages);
    return `${data.document_pages} PDF pages. Selected pages ${data.first_page} to ${data.last_page}: ${data.pages_total} pages in ${batches} planned ${batches===1?'batch':'batches'}.`;
  }
  async function previewFile(){
    const generation=++previewGeneration,file=el('pdf-file').files[0];
    if(!file){preflight=null;el('pdf-preflight').hidden=true;return;}
    el('pdf-preflight').hidden=false;el('pdf-preflight').textContent='Checking PDF…';
    try{const data=await inspectFile(file);if(generation===previewGeneration)el('pdf-preflight').textContent=describePreflight(data);}
    catch(error){if(generation===previewGeneration)el('pdf-preflight').textContent=error.message;}
  }
  el('pdf-file').addEventListener('change',()=>{preflight=null;return previewFile();});
  el('pdf-first').addEventListener('change',previewFile);el('pdf-last').addEventListener('change',previewFile);
  el('settings-form').addEventListener('submit',async event=>{
    event.preventDefault();const upload=Number(el('settings-upload-limit').value),batch=Number(el('settings-batch-pages').value);
    if(!Number.isInteger(upload)||upload<1||upload>100||!Number.isInteger(batch)||batch<1||batch>100){el('settings-status').textContent='Choose a PDF limit from 1 to 100 MB and a batch size from 1 to 100 pages.';return;}
    el('settings-save').disabled=true;
    try{applySettings(await(await request('/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({upload_limit_mb:upload,batch_pages:batch})})).json());el('settings-status').textContent='Settings saved.';if(el('pdf-file').files[0])await previewFile();}
    catch(error){el('settings-status').textContent=error.message;}
    finally{el('settings-save').disabled=false;}
  });
  function graphName(graph){
    const index=(manifest?.graphs||[]).findIndex(item=>String(item.id)===String(graph.id));
    return graph.extraction==='page_fallback'?'Whole-page review':`Graph ${index+1}`;
  }
  function readingState(graph){
    return graph.recognition==='qualitative_description'?'Description available':graph.recognition==='estimated_coordinates'?'Estimated coordinates':'Needs review';
  }
  function selectedGraph(){return manifest?.graphs.find(graph=>String(graph.id)===el('pdf-region').value);}
  function showSource(){
    const graph=selectedGraph();
    if(graph)el('pdf-page').value=String(graph.pdf_page);
    const page=manifest?.pages.find(item=>String(item.pdf_page)===el('pdf-page').value);
    el('pdf-page-text').textContent=page?.text||'No native text available for this page.';
    list('pdf-page-warnings',page?.warnings||[]);
    el('pdf-context').textContent=graph?.nearby_text||'No nearby text available.';
  }
  function updateButtons(){
    const graph=selectedGraph(),all=manifest?.graphs||[],index=all.findIndex(item=>String(item.id)===el('pdf-region').value);
    el('pdf-open').disabled=!graph||graph.recognition==='error';
    el('pdf-previous').disabled=index<=0;el('pdf-next').disabled=index<0||index>=all.length-1;
    showSource();
  }
  function renderState(data){
    manifest=data;const done=terminal(data.state),graphs=data.graphs||[],pages=data.pages||[];
    jobRunning=!done;
    const batch=data.batch?` Batch ${data.batch.index}: pages ${data.batch.first_page} to ${data.batch.last_page}.`:'';
    status(`${data.stage||data.state}. ${data.pages_done} of ${data.pages_total||'?'} pages; ${graphs.length} graph regions.${batch}`+(data.error?` ${data.error}`:''));
    el('pdf-progress').max=data.pages_total||1;el('pdf-progress').value=data.pages_done;
    el('pdf-cancel').disabled=done;el('pdf-cancel').hidden=done;el('pdf-progress').hidden=done;el('pdf-submit').disabled=!done;
    el('pdf-resume').hidden=!resumable(data);el('pdf-results').hidden=!graphs.length&&!pages.length;
    el('pdf-save').disabled=!graphs.length;list('pdf-warnings',data.warnings||[]);
    const nextSignature=`${pages.map(page=>page.pdf_page).join(',')}/${graphs.map(graph=>`${graph.id}:${graph.recognition}`).join(',')}`;
    if(signature!==nextSignature){
      signature=nextSignature;const selectedPage=el('pdf-page').value,selectedRegion=el('pdf-region').value;
      el('pdf-page').replaceChildren(...pages.map(page=>option(page.pdf_page,`PDF page ${page.pdf_page}`)));
      if(pages.some(page=>String(page.pdf_page)===selectedPage))el('pdf-page').value=selectedPage;
      el('pdf-region').replaceChildren(...graphs.map(graph=>option(graph.id,`${graphName(graph)}, PDF page ${graph.pdf_page} — ${readingState(graph)}`)));
      if(graphs.some(graph=>String(graph.id)===selectedRegion))el('pdf-region').value=selectedRegion;
      updateButtons();
    }
  }
  function clearSavedSelection(){try{sessionStorage.removeItem('recognition-lab-pdf-job');}catch(_){} }
  function permanentError(error){return [401,403,404].includes(error.status);}
  function stopUnavailable(error){
    clearTimeout(pollTimer);invalidateSelection(false);jobId=null;manifest=null;signature='';jobRunning=false;clearSavedSelection();window.GraphReaderUI.clear();
    el('pdf-submit').disabled=false;el('pdf-cancel').hidden=true;el('pdf-cancel').disabled=true;el('pdf-progress').hidden=true;el('pdf-resume').hidden=true;el('pdf-results').hidden=true;
    status(error.status===404?'This saved PDF is no longer available. Choose the PDF again.':'The session has expired. Reload this page and open the PDF again.');
  }
  async function openRegion({manual=true,focus=true}={}){
    if(window.graphReaderBusy){el('pdf-selection').textContent='Wait for the current image or AI reading to finish.';return;}
    const id=jobId,gid=el('pdf-region').value,graph=selectedGraph();if(!id||!graph||graph.recognition==='error')return;
    invalidateSelection(manual);window.GraphReaderUI.clear();const generation=loadGeneration;
    el('pdf-selection').textContent=`Loading ${graphName(graph).toLowerCase()} from PDF page ${graph.pdf_page}.`;
    try{
      const [data,image]=await Promise.all([request(`/pdf-jobs/${id}/graphs/${gid}.json`).then(response=>response.json()),request(`/pdf-jobs/${id}/graphs/${gid}.png`).then(response=>response.blob())]);
      if(generation!==loadGeneration||id!==jobId)return;
      const label=`${graphName(graph)}, PDF page ${graph.pdf_page}`;window.GraphReaderUI.show(data,image,label);
      el('pdf-selection').textContent=label+'.'+(graph.extraction==='page_fallback'?' No separate graph was located.':'');
      if(focus){el('result-title').setAttribute('tabindex','-1');el('result-title').focus();}
    }catch(error){if(generation===loadGeneration)el('pdf-selection').textContent=error.message;}
  }
  async function maybeAutoOpen(){
    if(!manifest||!terminal(manifest.state)||!autoOpenPending)return;
    autoOpenPending=false;if(selectionTouched||!['complete','partial'].includes(manifest.state)||window.graphReaderBusy)return;
    const graph=manifest.graphs.find(useful);if(!graph)return;
    el('pdf-region').value=String(graph.id);updateButtons();await openRegion({manual:false,focus:false});
  }
  async function poll(id){
    if(id!==jobId)return;
    try{
      const data=await(await request(`/pdf-jobs/${id}`)).json();if(id!==jobId)return;
      renderState(data);await maybeAutoOpen();
      if(!terminal(data.state))pollTimer=setTimeout(()=>poll(id),1200);else refreshHistory();
    }catch(error){
      if(id!==jobId)return;
      if(permanentError(error)){stopUnavailable(error);return;}
      status(`${error.message} Retrying status; Cancel remains available.`);pollTimer=setTimeout(()=>poll(id),2500);
    }
  }
  function beginJob(id){
    clearTimeout(pollTimer);jobId=id;manifest=null;signature='';selectionTouched=false;autoOpenPending=true;jobRunning=true;
    el('pdf-submit').disabled=true;
    invalidateSelection(false);window.GraphReaderUI.clear();el('pdf-results').hidden=true;el('pdf-cancel').disabled=false;el('pdf-cancel').hidden=false;el('pdf-progress').hidden=false;el('pdf-resume').hidden=true;
    try{sessionStorage.setItem('recognition-lab-pdf-job',id);}catch(_){}
  }
  el('pdf-form').addEventListener('submit',async event=>{
    event.preventDefault();if(window.graphReaderBusy){status('Wait for the current image or AI reading to finish.');return;}
    if(active()){status('Cancel the current PDF before starting another.');return;}
    const file=el('pdf-file').files[0];if(!file)return;
    starting=true;el('pdf-submit').disabled=true;status('Checking PDF…');
    try{
      const requestedRange=JSON.stringify(selectedRange());
      const metadata=await inspectFile(file);el('pdf-preflight').hidden=false;el('pdf-preflight').textContent=describePreflight(metadata);
      if(el('pdf-file').files[0]!==file||JSON.stringify(selectedRange())!==requestedRange)throw Error('The PDF selection changed. Read the selected PDF again.');
      status('Opening PDF…');
      const data=await(await request('/pdf-jobs',{method:'POST',body:file,headers:{...rangeHeaders(selectedRange()),'X-PDF-Name':encodeURIComponent(file.name||'document.pdf'),'X-PDF-Quality':el('pdf-quality').value,'X-Use-VLM':el('pdf-vlm').checked?'1':'0'}})).json();
      beginJob(data.id);await poll(jobId);
    }catch(error){status(error.message);el('pdf-submit').disabled=false;}
    finally{starting=false;}
  });
  el('pdf-cancel').addEventListener('click',async()=>{
    if(!jobId)return;el('pdf-cancel').disabled=true;
    try{const data=await(await request(`/pdf-jobs/${jobId}/cancel`,{method:'POST'})).json();clearTimeout(pollTimer);renderState(data);refreshHistory();}
    catch(error){if(permanentError(error))stopUnavailable(error);else{status(error.message);el('pdf-cancel').disabled=false;}}
  });
  async function resumeJob(id){
    if(active()){status('Cancel the current PDF before resuming another.');return;}
    if(window.graphReaderBusy){status('Wait for the current image or AI reading to finish.');return;}
    starting=true;el('pdf-resume').disabled=true;
    try{await request(`/pdf-jobs/${id}/resume`,{method:'POST'});beginJob(id);await poll(id);}
    catch(error){if(permanentError(error))stopUnavailable(error);else status(error.message);}
    finally{starting=false;el('pdf-resume').disabled=false;}
  }
  el('pdf-resume').addEventListener('click',()=>{if(jobId)return resumeJob(jobId);});
  el('pdf-region').addEventListener('change',()=>{invalidateSelection();window.GraphReaderUI.clear();updateButtons();});
  el('pdf-page').addEventListener('change',()=>{
    invalidateSelection();window.GraphReaderUI.clear();const page=el('pdf-page').value,graph=manifest?.graphs.find(item=>String(item.pdf_page)===page);
    if(graph){el('pdf-region').value=String(graph.id);updateButtons();}else{el('pdf-region').value='';updateButtons();el('pdf-page').value=page;showSource();}
  });
  el('pdf-open').addEventListener('click',()=>openRegion());
  async function adjacent(direction){
    const all=manifest?.graphs||[],index=all.findIndex(graph=>String(graph.id)===el('pdf-region').value),graph=all[index+direction];if(!graph)return;
    invalidateSelection();window.GraphReaderUI.clear();el('pdf-region').value=String(graph.id);updateButtons();await openRegion();
  }
  el('pdf-previous').addEventListener('click',()=>adjacent(-1));el('pdf-next').addEventListener('click',()=>adjacent(1));
  function downloadBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  el('pdf-download').addEventListener('click',()=>{if(manifest)downloadBlob(new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'}),'pdf-inspection-manifest.json');});
  el('pdf-save').addEventListener('click',async()=>{
    if(!jobId)return;el('pdf-save').disabled=true;
    try{const blob=await(await request(`/pdf-jobs/${jobId}/report.html`)).blob();downloadBlob(blob,'pdf-descriptions.html');}
    catch(error){status(error.message);}finally{el('pdf-save').disabled=!(manifest?.graphs.length);}
  });
  async function openSavedJob(id){
    if(starting||(active()&&id!==jobId)){status('Cancel the current PDF before opening another.');return;}
    try{const data=await(await request(`/pdf-jobs/${id}`)).json();beginJob(id);renderState(data);await maybeAutoOpen();if(!terminal(data.state))await poll(id);}
    catch(error){if(permanentError(error))stopUnavailable(error);else status(error.message);}
  }
  async function refreshHistory(){
    try{
      const data=await(await request('/pdf-jobs')).json(),jobs=data.jobs||[];
      el('pdf-history-list').replaceChildren(...jobs.map(job=>{
        const item=document.createElement('li'),name=job.name||job.filename||'PDF',text=document.createElement('span'),open=document.createElement('button');
        text.textContent=`${name} — ${job.state}; ${job.pages_done} of ${job.pages_total} pages. `;
        open.type='button';open.className='secondary';open.textContent='Open';open.setAttribute('aria-label',`Open ${name}`);open.addEventListener('click',()=>openSavedJob(job.id));
        const children=[text,open];
        if(resumable(job)){const resume=document.createElement('button');resume.type='button';resume.textContent='Resume';resume.setAttribute('aria-label',`Resume ${name}`);resume.addEventListener('click',()=>resumeJob(job.id));children.push(resume);}
        item.replaceChildren(...children);return item;
      }));el('pdf-history-status').textContent=jobs.length?'':'No saved PDFs.';
    }catch(error){el('pdf-history-status').textContent=error.message;}
  }
  el('pdf-history-refresh').addEventListener('click',refreshHistory);
  (async()=>{
    let healthKnown=false;el('pdf-vlm').checked=false;el('pdf-vlm').disabled=true;
    try{
      const response=await fetch('/health'),health=await response.json();healthKnown=true;
      const hasLocalAi=health.vlm_installed===true;el('pdf-vlm').checked=hasLocalAi;el('pdf-vlm').disabled=!hasLocalAi;el('pdf-vlm-help').hidden=hasLocalAi;
      if(!hasLocalAi)el('pdf-vlm-help').textContent='Local AI model is not installed.';
      if(!health.pdf_available){status('PDF dependencies are missing. See README.txt for installation. Image reading remains available.');el('pdf-submit').disabled=true;return;}
      await refreshHistory();
      const previous=sessionStorage.getItem('recognition-lab-pdf-job');
      if(previous&&/^[a-f0-9]{32}$/.test(previous))await openSavedJob(previous);
    }catch(error){if(!healthKnown){el('pdf-vlm-help').hidden=false;el('pdf-vlm-help').textContent='Local AI availability could not be checked.';}}
  })();
})();
