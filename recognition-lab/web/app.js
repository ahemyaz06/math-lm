const $=id=>document.getElementById(id);let result=null,sourceImage=null,fragmentIndex=0,pointIndex=0,markedIndex=-1,noteIndex=-1,stepIndex=1,timer=null;const steps=[1,5,10,20];
const names={likely_coordinate_plane:'Likely coordinate plane',uncertain:'Coordinate-system detection is uncertain',no_plane_evidence:'No coordinate-plane evidence found'};
const palette={purple:'#7040b0',blue:'#185abd',green:'#087443',orange:'#a54c00',red:'#b3261e',dark:'#202020'};
// A native select keeps both upload workflows available without a wall of controls.
function selectSource(){
  const image=$('source-type').value==='image';
  $('image-workspace').hidden=!image;$('pdf-workspace').hidden=image;
  $('status').hidden=!image&&$('result').hidden;
}
$('source-type').addEventListener('change',selectSource);
$('source-type').value='pdf';selectSource();
const format=v=>Number(v.toFixed(2)).toString();
function list(id,items){$(id).replaceChildren(...items.map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));}
function paths(){return result?.reading?.paths||[];}
function announce(text){clearTimeout(timer);timer=setTimeout(()=>{$('point-status').textContent=text;},70);}
function curveText(p){
  const ce=p?.curve_estimate;
  if(ce){
    if(ce.type==='quadratic')return `Estimated quadratic curve: ${ce.equation}, vertex (${format(ce.vertex[0])}, ${format(ce.vertex[1])}).`;
    if(ce.type==='cubic')return `Estimated cubic polynomial: ${ce.equation}, inflection (${format(ce.inflection[0])}, ${format(ce.inflection[1])}).`;
    if(ce.type==='square_root')return `Estimated square-root curve: ${ce.equation}, start (${format(ce.start[0])}, ${format(ce.start[1])}).`;
    if(ce.type==='piecewise_linear')return `Estimated piecewise linear curve: ${ce.equation}, corner (${format(ce.breakpoint[0])}, ${format(ce.breakpoint[1])}).`;
    if(ce.type==='circle')return `Estimated circle: ${ce.equation}, center (${format(ce.center[0])}, ${format(ce.center[1])}), radius ${format(ce.radius)}.`;
    if(ce.type==='ellipse')return `Estimated ellipse: ${ce.equation}, center (${format(ce.center[0])}, ${format(ce.center[1])}), semi-axes ${format(ce.rx)} and ${format(ce.ry)}.`;
    if(ce.type==='absolute_value')return `Estimated absolute value curve: ${ce.equation}, vertex (${format(ce.vertex[0])}, ${format(ce.vertex[1])}).`;
    if(ce.type==='line')return ce.subtype==='vertical'?`Estimated vertical line: ${ce.equation}.`:`Estimated straight line: ${ce.equation} (slope ${format(ce.slope)}, Y-intercept ${format(ce.intercept)}).`;
  }
  if(p?.line_estimate){
    const line=p.line_estimate;
    return line.type==='vertical'?`Possible vertical stroke, estimated X = ${format(line.x)}.`:`Possible straight stroke, local estimate: Y = ${format(line.slope)} times X plus ${format(line.intercept)}.`;
  }
  return '';
}
function description(){
  const read=result?.reading,span=read?.axis_span,p=paths()[fragmentIndex];
  const planeText=span?`Coordinate plane with X-axis from ${format(span.x[0])} to ${format(span.x[1])} and Y-axis from ${format(span.y[0])} to ${format(span.y[1])}. `:'';
  if(!p)return planeText+(read?.verbal_summary||'No recovered fragment.');
  const fragText=p.verbal_description||(`${p.color} curve with ${p.points.length} sampled positions. `+curveText(p));
  const prefix=paths().length>1?`Fragment ${fragmentIndex+1} of ${paths().length}: `:'';
  return `${planeText}${prefix}${fragText}`;
}
function drawReconstructed(pixel){
  const canvas=$('reconstructed');if(!canvas||!result)return;
  [canvas.width,canvas.height]=result.analysis_size;
  const c=canvas.getContext('2d');c.fillStyle='#ffffff';c.fillRect(0,0,canvas.width,canvas.height);
  const read=result.reading,p=result.axis_candidate,sx=read?.scale?.x,sy=read?.scale?.y;
  if(!p||!sx||!sy)return;
  const toPx=(x,y)=>[(x-sx.offset)/sx.units_per_pixel,(y-sy.offset)/sy.units_per_pixel];
  const span=read.axis_span;
  const x0=sx.units_per_pixel*p.h[0]+sx.offset,x1=sx.units_per_pixel*p.h[2]+sx.offset;
  const y0=sy.units_per_pixel*p.v[3]+sy.offset,y1=sy.units_per_pixel*p.v[1]+sy.offset;
  const xMin=span?span.x[0]:Math.ceil(Math.min(x0,x1)),xMax=span?span.x[1]:Math.floor(Math.max(x0,x1));
  const yMin=span?span.y[0]:Math.ceil(Math.min(y0,y1)),yMax=span?span.y[1]:Math.floor(Math.max(y0,y1));
  const xStep=Math.max(1,Math.round((xMax-xMin)/10)),yStep=Math.max(1,Math.round((yMax-yMin)/10));
  c.strokeStyle='#e2e8f0';c.lineWidth=1;c.fillStyle='#334155';c.font='12px system-ui,sans-serif';
  for(let xv=Math.ceil(xMin/xStep)*xStep;xv<=xMax;xv+=xStep){
    const [px]=toPx(xv,0);c.beginPath();c.moveTo(px,p.v[1]);c.lineTo(px,p.v[3]);c.stroke();
    if(xv!==0)c.fillText(String(xv),px-6,Math.min(canvas.height-6,p.y+16));
  }
  for(let yv=Math.ceil(yMin/yStep)*yStep;yv<=yMax;yv+=yStep){
    const [,py]=toPx(0,yv);c.beginPath();c.moveTo(p.h[0],py);c.lineTo(p.h[2],py);c.stroke();
    if(yv!==0)c.fillText(String(yv),Math.max(4,p.x-22),py+4);
  }
  c.strokeStyle='#0f172a';c.lineWidth=2;
  c.beginPath();c.moveTo(p.h[0],p.y);c.lineTo(p.h[2],p.y);c.moveTo(p.x,p.v[1]);c.lineTo(p.x,p.v[3]);c.stroke();
  paths().forEach((frag,idx)=>{
    c.strokeStyle=idx===fragmentIndex?'#ee00cc':(palette[frag.color]||'#185abd');
    c.lineWidth=idx===fragmentIndex?3:2;
    c.beginPath();frag.pixels.forEach((v,i)=>i?c.lineTo(...v):c.moveTo(...v));c.stroke();
  });
  (read.marked_points||[]).forEach(pt=>{
    c.fillStyle=palette[pt.color]||'#b3261e';c.beginPath();c.arc(...pt.pixel,5,0,Math.PI*2);c.fill();
  });
  (read.annotations||[]).forEach(n=>{
    c.fillStyle='#0f172a';c.font='bold 12px system-ui,sans-serif';c.fillText(n.text,n.pixel[0]+6,n.pixel[1]-4);
  });
  if(pixel){
    c.strokeStyle='#ffffff';c.lineWidth=5;c.beginPath();c.arc(...pixel,8,0,Math.PI*2);c.stroke();
    c.strokeStyle='#000000';c.lineWidth=2;c.stroke();
    c.beginPath();c.moveTo(pixel[0]-12,pixel[1]);c.lineTo(pixel[0]+12,pixel[1]);c.moveTo(pixel[0],pixel[1]-12);c.lineTo(pixel[0],pixel[1]+12);c.stroke();
  }
}
function draw(pixel){if(!sourceImage||!result)return;const canvas=$('preview');[canvas.width,canvas.height]=result.analysis_size;const c=canvas.getContext('2d');c.drawImage(sourceImage,0,0,canvas.width,canvas.height);const p=paths()[fragmentIndex];if(p){c.strokeStyle='#ee00cc';c.lineWidth=2;c.beginPath();p.pixels.forEach((v,i)=>i?c.lineTo(...v):c.moveTo(...v));c.stroke();}if(pixel){c.strokeStyle='white';c.lineWidth=5;c.beginPath();c.arc(...pixel,8,0,Math.PI*2);c.stroke();c.strokeStyle='black';c.lineWidth=2;c.stroke();c.beginPath();c.moveTo(pixel[0]-12,pixel[1]);c.lineTo(pixel[0]+12,pixel[1]);c.moveTo(pixel[0],pixel[1]-12);c.lineTo(pixel[0],pixel[1]+12);c.stroke();}drawReconstructed(pixel);}
function move(delta=0,prefix=''){const p=paths()[fragmentIndex];if(!p)return;markedIndex=-1;noteIndex=-1;const old=pointIndex;pointIndex=Math.max(0,Math.min(p.points.length-1,pointIndex+delta));const [x,y]=p.points[pointIndex];const edge=delta&&pointIndex===old?' End of recovered fragment.':'';const text=`X ${format(x)}, Y ${format(y)}.`;$('position').textContent=`Fragment ${fragmentIndex+1}. ${text} Step ${steps[stepIndex]} samples.`;draw(p.pixels[pointIndex]);announce(prefix+text+edge);}
function selectFragment(index){if(!paths().length)return;fragmentIndex=(index+paths().length)%paths().length;pointIndex=0;$('fragment').value=String(fragmentIndex);$('table-wrap').hidden=true;$('table-toggle').setAttribute('aria-expanded','false');$('table-toggle').textContent='Show sampled values';move(0,`Fragment ${fragmentIndex+1}. `);}
$('fragment').onchange=()=>selectFragment(Number($('fragment').value));$('enter').onclick=()=>{$('explorer').focus();move();};
$('explorer').addEventListener('keydown',event=>{if(event.ctrlKey||event.altKey||event.metaKey)return;const key=event.key.toLowerCase();const commands={j:()=>move(-steps[stepIndex]),k:()=>move(steps[stepIndex]),arrowleft:()=>move(-steps[stepIndex]),arrowright:()=>move(steps[stepIndex]),'[':()=>selectFragment(fragmentIndex-1),']':()=>selectFragment(fragmentIndex+1),home:()=>{pointIndex=0;move();},end:()=>{if(paths()[fragmentIndex]){pointIndex=paths()[fragmentIndex].points.length-1;move();}},f:()=>{stepIndex=(stepIndex+1)%steps.length;move(0,`Step ${steps[stepIndex]} samples. `);},i:()=>announce(description()),p:()=>{const points=result?.reading?.marked_points||[];if(!points.length){announce('No marked-point candidates.');return;}markedIndex=(markedIndex+1)%points.length;const p=points[markedIndex];draw(p.pixel);announce(`Possible point ${markedIndex+1}. X ${format(p.coordinate[0])}, Y ${format(p.coordinate[1])}.`);},n:()=>{const notes=result?.reading?.annotations||[];if(!notes.length){announce('No text notes detected on the graph.');return;}noteIndex=(noteIndex+1)%notes.length;const n=notes[noteIndex];draw(n.pixel);const loc=n.coordinate?` near X ${format(n.coordinate[0])}, Y ${format(n.coordinate[1])}`:'';announce(`Note ${noteIndex+1}: ${n.text}${loc}.`);}};if(commands[key]&&(paths().length||key==='i'||key==='p'||key==='n')){event.preventDefault();commands[key]();}});
$('reconstructed')?.addEventListener('click',event=>{
  if(!result?.reading||result.reading.status!=='estimated_coordinates')return;
  const rect=event.currentTarget.getBoundingClientRect();
  const px=(event.clientX-rect.left)*(event.currentTarget.width/rect.width);
  const py=(event.clientY-rect.top)*(event.currentTarget.height/rect.height);
  let bestDist=Infinity,bestSelect=null;
  paths().forEach((frag,fi)=>{frag.pixels.forEach((q,pi)=>{const d=Math.hypot(q[0]-px,q[1]-py);if(d<bestDist){bestDist=d;bestSelect=()=>{fragmentIndex=fi;pointIndex=pi;$('fragment').value=String(fi);move(0,`Selected Fragment ${fi+1}. `);};}});});
  if(bestSelect&&bestDist<=28){bestSelect();return;}
  const sx=result.reading.scale.x,sy=result.reading.scale.y;
  const x=sx.units_per_pixel*px+sx.offset,y=sy.units_per_pixel*py+sy.offset;
  draw([px,py]);$('position').textContent=`Cursor X ${format(x)}, Y ${format(y)}.`;announce(`Cursor X ${format(x)}, Y ${format(y)}.`);
});
function showVlmResult(vlm){
  const sec=$('vlm-section'),out=$('vlm-output');
  if(!sec||!out)return '';
  if(!vlm){sec.hidden=true;return '';}
  sec.hidden=false;
  const summary=vlm.parsed?.verbal_summary;
  const accepted=vlm.available&&vlm.assessment==='unverified_ai'&&vlm.response_mode==='qualitative_graph'&&typeof summary==='string'&&summary.trim();
  $('vlm-provenance').hidden=!accepted;
  // Raw or partial model output stays in the downloadable diagnostics.
  if(!accepted){out.textContent=vlm.error||'The AI response could not be validated.';return '';}
  out.textContent=summary;return summary;
}
let activeImageBlob=null,displayGeneration=0;
function clearReading(){
  ++displayGeneration;result=null;sourceImage=null;activeImageBlob=null;clearTimeout(timer);
  $('point-status').textContent='';$('result').hidden=true;$('vlm-section').hidden=true;
  $('table-wrap').replaceChildren();$('table-wrap').hidden=true;
  $('table-toggle').setAttribute('aria-expanded','false');$('table-toggle').textContent='Show sampled values';
}
function showReading(data,file,label=''){
  clearReading();
$('status').hidden=false;
result=data;activeImageBlob=file;const generation=++displayGeneration;const read=data.reading;const available=read?.status==='estimated_coordinates';const qualitative=read?.status==='qualitative_description';let summary=available?`Axis values recovered. ${read.paths.length} visible stroke fragment${read.paths.length===1?'':'s'} recovered with estimated coordinates.`:qualitative?'AI description; numerical scale unverified.':(names[data.status]?names[data.status]+'.':'Reading needs review.');$('summary').textContent=summary;if($('verbal-description'))$('verbal-description').textContent=read?.verbal_summary||'';$('status').textContent='Reading ready.';$('scale').textContent='';if(available){const p=data.axis_candidate,s=read.scale,span=read.axis_span;const x0=span?span.x[0]:(s.x.units_per_pixel*p.h[0]+s.x.offset),x1=span?span.x[1]:(s.x.units_per_pixel*p.h[2]+s.x.offset),y0=span?span.y[0]:(s.y.units_per_pixel*p.v[3]+s.y.offset),y1=span?span.y[1]:(s.y.units_per_pixel*p.v[1]+s.y.offset);$('scale').textContent=`Axis range: X from ${format(x0)} to ${format(x1)}; Y from ${format(y0)} to ${format(y1)}. (${s.x.labels_used} X labels and ${s.y.labels_used} Y labels read consistently.)`;}
showVlmResult(read?.vlm);
if(qualitative)$('vlm-section').hidden=true;
const objItems=[];
(read?.paths||[]).forEach((p,i)=>{objItems.push(`Fragment ${i+1}: ${p.verbal_description||curveText(p)||p.color}`);});
(read?.marked_points||[]).forEach((pt,i)=>{if(pt.coordinate)objItems.push(`Marked point ${i+1} (${pt.color}): (${format(pt.coordinate[0])}, ${format(pt.coordinate[1])})`);});
(read?.annotations||[]).forEach((n,i)=>{const loc=n.coordinate?` at (${format(n.coordinate[0])}, ${format(n.coordinate[1])})`:'';objItems.push(`Text note ${i+1}: "${n.text}"${loc}`);});
list('objects-list',objItems.length?objItems:['No curves, marked points, or text notes detected.']);
$('download-graph').hidden=!read?.graph_document;
$('download-image').hidden=!available;
list('evidence',data.evidence);const readingWarnings=read?.notes?.length?read.notes:(data.warnings||[]);list('warnings',readingWarnings);$('warning-section').hidden=!readingWarnings.length;list('ocr',data.ocr.map(t=>t.text));$('details').hidden=true;$('detail-toggle').setAttribute('aria-expanded','false');$('detail-toggle').textContent='Show measured details';$('result').hidden=false;$('reading').hidden=!available;$('fragment').replaceChildren(...paths().map((p,i)=>{const o=document.createElement('option');o.value=i;const eq=p.curve_estimate?.equation?` (${p.curve_estimate.equation})`:'';o.textContent=`Fragment ${i+1}, ${p.color}${eq}, ${p.points.length} samples`;return o;}));fragmentIndex=0;pointIndex=0;markedIndex=-1;noteIndex=-1;
$('table-wrap').replaceChildren();$('table-wrap').hidden=true;$('table-toggle').setAttribute('aria-expanded','false');$('table-toggle').textContent='Show sampled values';
const url=URL.createObjectURL(file),image=new Image();image.onload=()=>{if(generation!==displayGeneration){URL.revokeObjectURL(url);return;}sourceImage=image;if(paths().length){draw(paths()[0].pixels[0]);$('position').textContent='Select Explore curve to begin.';}else if(available){draw(null);$('position').textContent='Calibrated empty coordinate plane.';}URL.revokeObjectURL(url);};image.onerror=()=>URL.revokeObjectURL(url);image.src=url;
  if(label){$('result-title').textContent=label;}else{$('result-title').textContent='Reading';}
}
window.GraphReaderUI={show:showReading,clear:clearReading};
$('inspect').addEventListener('submit',async event=>{
  event.preventDefault();const file=$('image').files[0];if(!file)return;
  window.PdfReaderUI?.invalidateSelection();clearReading();
  $('status').hidden=false;
  if(file.size>10*1024*1024){$('status').textContent='Choose an image smaller than 10 MB.';return;}
  $('submit').disabled=true;window.graphReaderBusy=true;
  $('status').textContent='Reading the image locally.';
  try{
    const {token}=await(await fetch('/token')).json();const headers={'X-Local-Token':token};
    if($('use-vlm')?.checked)headers['X-Use-VLM']='1';
    const response=await fetch('/detect',{method:'POST',headers,body:file});const data=await response.json();
    if(!response.ok)throw Error(data.error||'Reading failed.');showReading(data,file);$('result-title').setAttribute('tabindex','-1');$('result-title').focus();
  }catch(error){$('status').textContent=error.message;}
  finally{$('submit').disabled=false;window.graphReaderBusy=false;}
});
$('run-vlm')?.addEventListener('click',async()=>{
  const file=activeImageBlob;if(!file)return;
  const generation=displayGeneration;$('run-vlm').disabled=true;window.graphReaderBusy=true;$('status').hidden=false;$('status').textContent='Asking local AI…';
  try{
    const {token}=await(await fetch('/token')).json();
    const response=await fetch('/vlm',{method:'POST',headers:{'X-Local-Token':token},body:file});
    const vlm=await response.json();
    if(!response.ok)throw Error(vlm.error||'Local AI request failed.');
    if(generation!==displayGeneration)return;const description=showVlmResult(vlm);
    const message=description?'AI description ready.':$('vlm-output').textContent;
    $('status').textContent=message;announce(description?'Unverified AI description. '+description:message);
  }catch(error){$('status').textContent=error.message;}
  finally{$('run-vlm').disabled=false;window.graphReaderBusy=false;}
});
$('table-toggle').onclick=()=>{const show=$('table-wrap').hidden;$('table-wrap').hidden=!show;$('table-toggle').setAttribute('aria-expanded',String(show));$('table-toggle').textContent=show?'Hide sampled values':'Show sampled values';if(!show)return;const p=paths()[fragmentIndex];if(!p)return;const table=document.createElement('table'),caption=table.createCaption();caption.textContent='Up to 80 estimated coordinate samples from this fragment.';const head=table.createTHead().insertRow();for(const label of ['X','Y']){const th=document.createElement('th');th.scope='col';th.textContent=label;head.append(th);}const body=table.createTBody();const stride=Math.max(1,Math.ceil(p.points.length/80));p.points.filter((_,i)=>i%stride===0).forEach(values=>{const row=body.insertRow();values.forEach(v=>row.insertCell().textContent=format(v));});$('table-wrap').replaceChildren(table);};
$('detail-toggle').onclick=()=>{const open=$('details').hidden;$('details').hidden=!open;$('detail-toggle').setAttribute('aria-expanded',String(open));$('detail-toggle').textContent=open?'Hide measured details':'Show measured details';};
$('download').onclick=()=>{if(!result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='graph-reading.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('download-graph').onclick=()=>{if(!result?.reading?.graph_document)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result.reading.graph_document,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='graph.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('download-image').onclick=()=>{const canvas=$('reconstructed');if(!canvas)return;const a=document.createElement('a');a.href=canvas.toDataURL('image/png');a.download='reconstructed-graph.png';a.click();};
$('stop').onclick=async()=>{$('status').hidden=false;try{const {token}=await(await fetch('/token')).json();const response=await fetch('/stop',{method:'POST',headers:{'X-Local-Token':token}});if(!response.ok)throw Error('Stop failed.');$('status').textContent='Recognizer stopped. You can close this tab.';$('submit').disabled=true;$('stop').disabled=true;}catch(error){$('status').textContent=error.message;}};


