'use strict';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
function validateImageDataUrl(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100) throw new Error('聊天图片过大，请缩小后重试。');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('无法读取聊天图片，请先在聊天中打开图片后重试。');
  const bytes = Buffer.from(match[2], 'base64');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !(match[1]==='png'&&png || match[1]==='jpeg'&&jpeg || match[1]==='webp'&&webp)) throw new Error('聊天图片格式无效，请重新打开图片。');
  return value;
}
function buildVisionConversation(payload = {}) {
  const rows=(Array.isArray(payload.messages)?payload.messages:[]).slice(-50).filter(m=>['incoming','outgoing'].includes(m?.direction));
  const candidates=[];
  rows.forEach((m,index)=>{for(const image of (Array.isArray(m.images)?m.images:[]).slice(0,MAX_IMAGES)) candidates.push({index,url:image.dataUrl});});
  const selected=candidates.slice(-MAX_IMAGES).map(image=>({...image,url:validateImageDataUrl(image.url)}));
  const messages=rows.map((m,index)=>({index:index+1,speaker:m.direction==='incoming'?'对方':'我',text:String(m.original_text||m.text||'').slice(0,6000),time:m.message_at||null,image_count:selected.filter(i=>i.index===index).length,unavailable_images:Math.max(0,(Number(m.image_count)||0)-selected.filter(i=>i.index===index).length)})).filter(m=>m.text.trim()||m.image_count||m.unavailable_images);
  return { messages, imageCount:selected.length, content(goal) {
    const text=JSON.stringify({my_reply_goal:goal||'自然承接当前对话，不额外设定销售目的',conversation:messages});
    if(!selected.length)return text;
    const blocks=[{type:'text',text}];
    for(const image of selected){
      blocks.push({type:'text',text:`以下图片属于第 ${image.index+1} 条消息，发送方：${rows[image.index].direction==='incoming'?'对方':'我'}。`});
      blocks.push({type:'image_url',image_url:{url:image.url,detail:'auto'}});
    }
    return blocks;
  }};
}
module.exports={MAX_IMAGES,MAX_IMAGE_BYTES,validateImageDataUrl,buildVisionConversation};
