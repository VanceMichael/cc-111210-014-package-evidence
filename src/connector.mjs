import {get}from './http.mjs';
export function lockedPackages(lock){if(lock.lockfileVersion!==3||!lock.packages)throw new Error('锁文件版本无效');return Object.entries(lock.packages).filter(([path])=>path.startsWith('node_modules/')).map(([path,item])=>({path,name:item.name??path.split('node_modules/').pop(),version:item.version,resolved:item.resolved,integrity:item.integrity,link:item.link??false}));}
export async function inspect(base){const lock=await(await get(base,'/lock')).json();const packages=lockedPackages(lock);return {packages,metadata:await(await get(base,'/metadata')).json()};}
