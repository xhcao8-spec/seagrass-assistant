'use strict';
const { validateImageDataUrl, MAX_IMAGES } = require('./assistant-vision.cjs');

async function readChatImages({ snapshot, captureRect, assertCurrent }) {
  const rows=(Array.isArray(snapshot.messages)?snapshot.messages:[]).slice(-50).filter(m=>['incoming','outgoing'].includes(m?.direction));
  const entries=[];
  for(const row of rows) for(const image of (Array.isArray(row.images)?row.images:[]).slice(0,MAX_IMAGES)) entries.push({row,image});
  const chosen=entries.slice(-MAX_IMAGES);
  const results=new Map();
  for(const {row,image} of chosen){
    let dataUrl=image.dataUrl;
    if(!dataUrl){
      const rect=image.rect,viewport=snapshot.viewport;
      if(!rect||!viewport||![rect.x,rect.y,rect.width,rect.height,viewport.width,viewport.height].every(Number.isFinite)
        ||rect.x<0||rect.y<0||rect.width<72||rect.height<72||rect.width>4096||rect.height>4096
        ||rect.x+rect.width>viewport.width||rect.y+rect.height>viewport.height) throw new Error('聊天图片尚未完整显示，请打开图片后重试。');
      await assertCurrent();
      dataUrl=await captureRect({x:Math.round(rect.x),y:Math.round(rect.y),width:Math.floor(rect.width),height:Math.floor(rect.height)});
    }
    validateImageDataUrl(dataUrl);
    const images=results.get(row)||[]; images.push({dataUrl}); results.set(row,images);
  }
  await assertCurrent();
  return rows.map(row=>({direction:row.direction,original_text:String(row.original_text||'').slice(0,20000),message_at:row.message_at||null,image_count:Number(row.image_count)||0,images:results.get(row)||[]}));
}
module.exports={readChatImages};
