'use strict';
const MAX_SEARCH_LENGTH = 120;
function normalizeSearchQuery(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_LENGTH);
}
function normalizeForMatch(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function listText(value) {
  if (!Array.isArray(value)) return '';
  return value.map(item => item && typeof item === 'object'
    ? [item.name,item.title,item.value,item.category].filter(Boolean).join(' ')
    : String(item || '')).filter(Boolean).join(' ');
}
function visibleSearchFields(item = {}) {
  const onlyporn = item?.extra?.onlyporn || {};
  return [
    [item.title || item.name,180], [listText(item.tags),140], [listText(item.genres),130],
    [listText(item.performers),130], [listText(item.links),110], [item.studio,110],
    [item.creator,100], [item.username,100], [item.channel,100], [item.account,100],
    [item.sceneCode || onlyporn.sceneCode,170], [listText(onlyporn.tags),130], [item.description,45],
  ].map(([value,weight]) => ({text:normalizeForMatch(value),weight})).filter(x => x.text);
}
function visibleSearchText(item = {}) { return visibleSearchFields(item).map(x => x.text).join(' '); }
function scoreSearchItem(item, rawQuery) {
  const query=normalizeForMatch(normalizeSearchQuery(rawQuery)); if (!query) return -1;
  const tokens=query.split(' ').filter(Boolean); if (!tokens.length) return -1;
  const fields=visibleSearchFields(item); const combined=fields.map(x=>x.text).join(' ');
  if (!tokens.every(t => combined.includes(t))) return -1;
  const title=normalizeForMatch(item?.title || item?.name); let score=0;
  if (title===query) score+=2500; else if (title.startsWith(query)) score+=1400; else if (title.includes(query)) score+=900;
  for (const token of tokens) for (const field of fields) {
    if (field.text===token) score+=field.weight*4; else if (field.text.startsWith(token)) score+=field.weight*2; else if (field.text.includes(token)) score+=field.weight;
  }
  return score;
}
function rankSearchItems(items, query) {
  return (Array.isArray(items)?items:[]).map((item,index)=>({item,index,score:scoreSearchItem(item,query)}))
    .filter(x=>x.score>=0).sort((a,b)=>b.score-a.score||a.index-b.index).map(x=>x.item);
}
function searchItemId(item = {}, index = 0) {
  const source=String(item.source || item?.extra?.onlyporn?.source || '').trim();
  const sourceId=String(item.sourceId || item.id || item.upstreamId || item.detailUrl || item.url || `${item.title || item.name || 'item'}:${index}`).trim();
  return `${source || 'unknown'}:${sourceId}`;
}
function mergeSearchItems(...groups) {
  const out=[]; const seen=new Set();
  for (const group of groups) for (const item of Array.isArray(group)?group:[]) {
    const id=searchItemId(item,out.length); if (!id || seen.has(id)) continue; seen.add(id); out.push(item);
  }
  return out;
}
module.exports={MAX_SEARCH_LENGTH,mergeSearchItems,normalizeForMatch,normalizeSearchQuery,rankSearchItems,scoreSearchItem,searchItemId,visibleSearchFields,visibleSearchText};
