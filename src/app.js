import { SubpixelRenderer } from './renderer.js';
const $ = id => document.getElementById(id);
let renderer, frame, fontGeneration = 0, inspection = { source: 'rendered', x: 40, y: 32 };
const names = {lcd:'LCD',harmony:'Harmony',gray:'Grayscale'};
function showError(error) { $('error').hidden = !error; $('error').textContent = error?.message || ''; if(error) $('export').disabled = true; }
function updateLabels() {
  $('size-value').textContent = `${$('size').value} px`;
  $('gamma-value').textContent = Number($('gamma').value).toFixed(1);
  $('strength-value').textContent = Number($('strength').value).toFixed(2);
  $('filter-controls').hidden = $('mode').value !== 'lcd';
  $('geometry-row').hidden = $('mode').value !== 'harmony';
  $('custom-row').hidden = $('filter').value !== 'custom';
  $('axis').disabled = $('order').disabled = $('mode').value === 'gray';
  $('mode-label').textContent = names[$('mode').value];

}
function render() {
  if (!renderer?.face) return;
  try {
    updateLabels();
    const start = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.floor($('rendered').parentElement.clientWidth - 2);
    const cssHeight = 162;
    const options = { text:$('text').value, size:Number($('size').value)*dpr, x:22*dpr, baseline:39*dpr, lineHeight:Number($('size').value)*1.65*dpr, mode:$('mode').value, axis:$('axis').value, order:$('order').value, geometry:$('mode').value === 'harmony' ? $('geometry').value : 'stripe', hinting:$('hinting').checked, filter:$('mode').value === 'lcd' ? $('filter').value : 'default', weights:$('weights').value.split(',').map(Number), gamma:Number($('gamma').value), strength:Number($('strength').value), foreground:$('foreground').value, background:$('background').value };
    let stats;
    for (const id of ['rendered','comparison']) {
      const canvas = $(id);
      canvas.width = Math.round(cssWidth*dpr); canvas.height = Math.round(cssHeight*dpr);
      canvas.style.width = `${canvas.width/dpr}px`; canvas.style.height = `${canvas.height/dpr}px`;
      const result = renderer.draw(canvas,{...options,mode:id==='comparison'?'gray':options.mode,filter:id==='comparison'?'default':options.filter});
      if (id==='rendered') stats=result;
    }
    $('status').textContent = `FreeType ${renderer.capabilities.version} / ${stats.glyphCount} glyphs / ${(performance.now()-start).toFixed(1)} ms / ${dpr.toFixed(2)}× device scale${stats.missingGlyphs ? ` / ${stats.missingGlyphs} missing glyphs` : ''}`;
    $('export').disabled = false;showError(null);magnify();
  } catch(error) { showError(error); }
}
function schedule() { cancelAnimationFrame(frame); frame=requestAnimationFrame(render); }
function magnify() {
  const source=$(inspection.source), canvas=$('magnified'), zoom=Number($('zoom').value);
  const dpr=window.devicePixelRatio||1;
  canvas.width=Math.round(canvas.parentElement.clientWidth*dpr);canvas.height=Math.round(canvas.parentElement.clientHeight*dpr);
  const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
  ctx.fillStyle=$('background').value;ctx.fillRect(0,0,canvas.width,canvas.height);
  // Zoom is specified per backing pixel; retain crisp integer scaling.
  const sw=canvas.width/zoom, sh=canvas.height/zoom;
  const sx=Math.round(Math.max(0,Math.min(source.width-sw,inspection.x*dpr-sw/2)));
  const sy=Math.round(Math.max(0,Math.min(source.height-sh,inspection.y*dpr-sh/2)));
  ctx.drawImage(source,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
  $('inspect-label').textContent=`${inspection.source==='comparison'?'Grayscale':names[$('mode').value]} · ${zoom}×`;
}
async function loadFont(bytes) {
  const info=renderer.loadFont(bytes);
  $('font-name').textContent=`${info.familyName} ${info.styleName}`;
  render();
}
$('controls').addEventListener('input',event=>{if(event.target.id!=='font-file') schedule();});
$('controls').addEventListener('submit',e=>e.preventDefault());
$('zoom').addEventListener('change',magnify);
for(const id of ['rendered','comparison']) $(id).addEventListener('pointermove',event=>{
  const rect=event.currentTarget.getBoundingClientRect();inspection={source:id,x:event.clientX-rect.left,y:event.clientY-rect.top};magnify();
});
$('upload').addEventListener('click',()=>$('font-file').click());
$('font-file').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  const generation=++fontGeneration;
  try { if(file.size>20*1024*1024)throw new Error('Please choose a font smaller than 20 MB.'); const bytes=await file.arrayBuffer();if(generation===fontGeneration)await loadFont(bytes); } catch(error){showError(new Error(`Could not load font: ${error.message}`));}
  event.target.value='';
});
$('reset').addEventListener('click',async()=>{
  $('controls').reset();inspection={source:'rendered',x:40,y:32};const generation=++fontGeneration;
  try {const response=await fetch('public/fonts/Lato-Regular.ttf');if(!response.ok)throw new Error('Could not load bundled font.');const bytes=await response.arrayBuffer();if(generation===fontGeneration)await loadFont(bytes);}catch(error){showError(error);}
});
$('export').addEventListener('click',()=>{
  $('rendered').toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`smeartype-${$('mode').value}.png`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
});
new ResizeObserver(schedule).observe($('rendered').parentElement);
window.addEventListener('resize',schedule);
try {
  renderer=await SubpixelRenderer.create();
  $('hinting').disabled=!renderer.capabilities.v40;
  $('hinting').checked=renderer.capabilities.v40;
  $('mode').querySelector('[value=harmony]').disabled=!renderer.capabilities.harmony;

  const response=await fetch('public/fonts/Lato-Regular.ttf');if(!response.ok)throw new Error('Could not load bundled font.');await loadFont(await response.arrayBuffer());
} catch(error){$('status').textContent='Renderer could not initialize.';showError(error);}
