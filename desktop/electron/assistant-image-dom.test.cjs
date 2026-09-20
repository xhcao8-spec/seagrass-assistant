const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./platform-preload.cjs'),'utf8');
const helpers=source.slice(source.indexOf('function assistantImageNodes('),source.indexOf("ipcRenderer.on('assistant:collect-context'"));
function setup(){
 const nodes=[];let latest=true;
 const context={innerWidth:800,innerHeight:600,Set,
  document:{querySelector:()=>({contains:()=>true}),createElement:()=>({getContext:()=>({drawImage(){}}),toDataURL:()=> 'data:image/jpeg;base64,/9j/AA=='})},
  isConversationAtLatestMessage:()=>latest,visibleMessageRoots:()=>nodes,findMessageText:m=>({textContent:m.text||''}),messageDirection:m=>m.direction,messageIdFor:m=>m.id,messageTimestampFor:()=>null};
 vm.runInNewContext(helpers,context);
 return {context,nodes,setLatest:value=>latest=value};
}
function img(overrides={}){return {complete:true,naturalWidth:900,naturalHeight:600,alt:'',closest:()=>null,getAttribute:()=>'',getBoundingClientRect:()=>({left:100,top:100,right:400,bottom:300,width:300,height:200}),...overrides};}
function message(id,images,text='',direction='incoming'){return {id,direction,text,querySelectorAll:s=>s==='img'?images:[]};}
test('image-only message is not dropped and caption stays attached to same sender',()=>{
 const h=setup();h.nodes.push(message('photo',[img()]),message('caption',[img()],'看我拍的照片','outgoing'));
 const rows=h.context.assistantMessagesFromVisibleDom(true);
 assert.equal(rows.length,2);assert.equal(rows[0].image_count,1);assert.equal(rows[0].original_text,'');assert.equal(rows[1].direction,'outgoing');assert.equal(rows[1].original_text,'看我拍的照片');assert.equal(rows[1].images.length,1);
});
test('avatars, quoted images, unknown senders and unloaded photos are excluded',()=>{
 const h=setup();h.nodes.push(message('bad',[img({alt:'avatar'}),img({closest:()=>({})}),img({complete:false})]),message('unknown',[img()],'','unknown'));
 assert.equal(h.context.assistantMessagesFromVisibleDom(true).length,0);
 h.setLatest(false);h.nodes.push(message('good',[img()]));assert.equal(h.context.assistantMessagesFromVisibleDom(true).length,0);
});
test('only most recent four photos are serialized and opening panel does not read pixel data',()=>{
 const h=setup();for(let i=0;i<7;i++)h.nodes.push(message(String(i),[img()]));
 assert.equal(h.context.assistantMessagesFromVisibleDom().some(m=>m.images),false);
 const rows=h.context.assistantMessagesFromVisibleDom(true);assert.equal(rows.reduce((n,m)=>n+m.images.length,0),4);assert.equal(rows[0].images.length,0);assert.equal(rows[6].images.length,1);
});
