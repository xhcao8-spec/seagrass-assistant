const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildVisionConversation,validateImageDataUrl}=require('./assistant-vision.cjs');
const {readChatImages}=require('./assistant-capture.cjs');
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=';
test('vision accepts only bounded inline image bytes, not external URLs or disguised content',()=>{
 assert.equal(validateImageDataUrl(image),image);
 for(const value of ['https://example.com/image.png','file:///secret','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,aGVsbG8='])assert.throws(()=>validateImageDataUrl(value));
 assert.throws(()=>validateImageDataUrl('data:image/png;base64,'+'a'.repeat(6*1024*1024)),/过大/);
});
test('latest four images retain order and explicit senders; unknown senders are ignored',()=>{
 const messages=Array.from({length:6},(_,i)=>({direction:i%2?'outgoing':'incoming',original_text:'消息'+i,image_count:1,images:[{dataUrl:image}]}));
 messages.push({direction:'unknown',images:[{dataUrl:'invalid'}]});
 const result=buildVisionConversation({messages});
 assert.equal(result.imageCount,4);
 const parts=result.content('我的目的');
 assert.equal(parts.filter(p=>p.type==='image_url').length,4);
 assert.match(parts[1].text,/第 3 条消息，发送方：对方/);
 assert.match(parts[7].text,/第 6 条消息，发送方：我/);
 assert.equal(JSON.parse(parts[0].text).conversation[0].unavailable_images,1);
});
test('capture includes only bounded image regions and never archives image bytes',async()=>{
 let checks=0,captures=0;
 const rows=await readChatImages({snapshot:{viewport:{width:800,height:600},messages:[{direction:'incoming',image_count:1,images:[{rect:{x:100,y:120,width:200,height:200}}]}]},assertCurrent:async()=>{checks++;},captureRect:async rect=>{captures++;assert.deepEqual(rect,{x:100,y:120,width:200,height:200});return image;}});
 assert.equal(rows[0].images[0].dataUrl,image);assert.equal(checks,2);assert.equal(captures,1);
});
test('offscreen or oversized captures are rejected before taking a screenshot',async()=>{
 let captured=false;
 await assert.rejects(readChatImages({snapshot:{viewport:{width:800,height:600},messages:[{direction:'incoming',images:[{rect:{x:-10,y:0,width:900,height:600}}]}]},assertCurrent:async()=>{},captureRect:async()=>{captured=true;return image;}}),/完整显示/);
 assert.equal(captured,false);
});
test('switching chat while collecting images aborts the request',async()=>{
 await assert.rejects(readChatImages({snapshot:{messages:[{direction:'outgoing',images:[{dataUrl:image}]}]},assertCurrent:async()=>{throw new Error('聊天已切换');},captureRect:async()=>image}),/聊天已切换/);
});
