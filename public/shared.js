// Shared by server and browser: same seed => same jungle on every machine
(function (g) {
  const MAP = 58; // half map size (m), shared by server and browser
  function rng(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
  function genTrees(seed){const r=rng(seed),t=[];for(let i=0;i<120;i++)t.push({x:(r()*2-1)*(MAP-3),z:(r()*2-1)*(MAP-3),r:.5+r()*.5,h:9});return t}
  const api = { MAP, genTrees };
  if (typeof module !== 'undefined') module.exports = api; else Object.assign(g, api);
})(typeof window !== 'undefined' ? window : globalThis);
