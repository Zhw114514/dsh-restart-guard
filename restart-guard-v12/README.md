# dsh-restart-guard閿涘潏andidate v10閿?
**閻楀牊婀伴悽杈侀崸妤€鐡ч懞鍌氭惐鐢苯鍠呯€规熬绱濇稉宥囨暠 package.json 閼奉亣鍫崘鍐茬暰閵嗗倹鐥呴張澶婂讲娣嚶ら煩娴犳枻绱濇稉宥呭竾缂傗斂鈧?*

## 娑撯偓閵嗕礁褰傜敮鍐煩娴犳枻绱伴崫鍫濈瑖鐞涖劌鏁稉鈧崘鍐茬暰閻楀牊婀?
| 閻楀牊婀?| profile | `lib/index.js` | `package.json` |
|---|---|---|---|
| 0.2.2-rc.1 | v022 | `eafe4adb閳ヮ泭bc54b` | `0a94a38f閳?462c3` |
| 0.2.3-alpha.2 | v023 | `a1ddbfad閳?fcbc9` | `77b81acf閳?b9431` |

閸濆牆绗囬弶銉ㄥ殰鐎规ɑ鏌熼崣鎴濈 tarball閿涘苯鍑￠弽绋款嚠濡楀矂娼伴柈銊ц `D:\DeepSeekHarness\resources\app.asar\dsh` 閻ㄥ嫬鐤勯梽鍛摟閼哄倷绗?tarball 娑撯偓閼锋番鈧?
鏉╂劘顢戦弮鏈电窗**闁插秵鏌婄拋锛勭暬濡€虫健閸濆牆绗囬獮鑸电叀鐞?*閿涙艾鎳℃稉顓炴憿娑撯偓閻楀牆姘ㄩ弰顖氭憿娑撯偓閻楀牞绱盿ttestation 闁插瞼娈戦悧鍫熸拱閸欘亞鏁ゆ禍搴☆嚠鐠愶讣绱濇稉宥勭閼锋潙宓?defer閵嗗倷鍚夐柅?package.json 閺冪姵纭堕弨鐟板綁闊偂鍞ら垾鏂衡偓鏂跨暊娴兼艾婀０鍕梾闂冭埖顔岀悮?濡€虫健閸濆牆绗囩拠?0.2.2閵嗕垢ackage.json 鐠?0.2.3"閻ㄥ嫪绔撮懛瀛樷偓褎顥呴弻銉﹀娑撳鈧?
## 娴滃被鈧線顣╁Λ鈧敍鍦朣H 閸氼垰濮╅崜宥忕礆

```
node scripts/attest.mjs --runtime <app.asar/dsh> --profile desktop \
  --profile-dir <profile 閻╊喖缍? --out <attestation.json> --boot-id <閺堫剚顐奸崥顖氬З id>
```

- 閸欘亝甯撮崣?**runtimeRoot**閿涘奔绗夐幒銉ュ綀鐠嬪啰鏁ら懓鍛舶閻?module/package 鐠侯垰绶為敍?- 娴?`<runtimeRoot>/package.json` 鐠囪锛愰弰搴ｆ畱閻楀牊婀伴敍宀€宸辨径鍗炲祮婢惰精瑙﹂敍鍫滅瑝闂勫秶楠囬敍澶涚幢
- 鐟欙絾鐎?`<runtimeRoot>/node_modules/@deepseek-ai/dsh-compaction-basic`閿涘瞼鐣婚崫鍫濈瑖閺屻儴銆冮敍?- 娴溿倕寮堕弽锟犵崣 package name閵嗕垢ackage.json 閻楀牊婀伴妴涔竌ckage.json 鐎涙濡崫鍫濈瑖閵嗕浇绻嶇悰灞炬濞撳懎宕熼悧鍫熸拱閿?- asar 閸愬懏鏋冩禒鍓佺病 `@electron/asar` 鐠囪褰囬敍娑氣敄 profile 閻╁瓨甯存径杈Е閿?- 閺堫剝鐤嗛崣顏呮暜閹镐焦顢戦棃?`<app.asar>/dsh`閿涘瘈npacked CLI 娑撯偓瀵?defer閵?
## 娑撳鈧浇绻嶇悰灞炬缂佹垵鐣?
1. attestation閿涙chema閵嗕梗bootId` 娑撳孩婀板▎鈥虫儙閸斻劋绔撮懛娣偓涔竢ofile 闂堢偟鈹栨稉鏂垮爱闁板秲鈧焦婀潻鍥ㄦ埂閿涘牓绮拋?24h閿涘绱?2. `modulePath` 韫囧懘銆忛崷?`runtimeRoot` 閸愬拑绱?*閹稿鐭惧鍕瀻濞堥潧鍨介弬?*閿涘奔绗夐弰顖氱摟缁楋缚瑕嗛崜宥囩磻閿涘绱?3. 婢跺秶鐣诲Ο鈥虫健閸濆牆绗?閳?閺屻儴銆?閳?閺夊啫鈻?version/profile閿涙矘ttestation 閻楀牊婀版稉搴濈娑撳秶顑?閳?defer閿?4. `package.json` 鐠侯垰绶炴稊鐔锋躬 `runtimeRoot` 閸愬拑绱濈€涙濡崫鍫濈瑖閸涙垝鑵戠悰顭掔幢
5. `import(modulePath)`閿涘苯浠涚€电钖勯煬顐″敜 / 閸樼喎鐎?/ 閺傝纭剁€瑰本鏆ｉ幀褎顥呴弻銉ｂ偓?
## 閸ユ稏鈧赋2-3閿涙碍鐦″▎鈥冲З閹靛澧犳径宥嗙壋

妫ｆ牗顐奸弽鎼佺崣閺冭埖濡告稉澶夐嚋閸忔娊鏁弬瑙勭《閻?*閸戣姤鏆熷鏇犳暏**鐎涙绻樿箛顐ゅ弾閵嗗倹鐦″▎?`pruneSession()` 閸撳秲鈧焦鐦″▎?`compactRegion()` 閸撳稄绱?
- attestation 娴犲秴婀弬鐗堟櫏閺堢喎鍞撮敍?- `engine.constructor === 韫囶偆鍙庣猾绫ら妴浣稿斧閸ㄥ绮涢弰顖氭彥閻撗冨斧閸ㄥ绱?- 鐎圭偘绶ュ▽鈩冩箒 own-property 鐟曞棛娲婇敍?- 瑜版挸澧?prototype 娑撳﹦娈戦弬瑙勭《**娴犲秶鐡戞禍搴℃彥閻撗囧櫡閻ㄥ嫬鍤遍弫鏉跨穿閻?*閿涘牆娲滃?prototype 鐞氼偅娴涢幑顫瘍閼宠棄褰傞悳甯礆閿?- 閺傝纭舵禒宥嗘Ц function閵?
娴犺绔存径杈Е 閳?缁斿宓?`FAILED`閿涘奔绗夐崘娆忓弳閵?
## 娴滄柣鈧椒淇婃禒鏄忕珶閻ｅ矉绱欓柌宥堫洣閿?
閺堫剝鐤嗛崫鍫濈瑖閸欘亣鐦夐弰?`@deepseek-ai/dsh-compaction-basic` 閻?`lib/index.js` 娑?`package.json` 娑撳骸鐣奸弬鐟板絺鐢啩绔撮懛娣偓?*濞屸剝婀?*鐠囦焦妲戦崗鏈电稇娓氭繆绂嗛弽鎴犳畱鐎瑰本鏆ｉ幀褝绱濇稊鐔哥梾閺堝鐦夐弰搴ょ箥鐞涘本婀￠崘鍛摠閺堫亣顫﹀▔銊ュ弳閵?
瀹歌尙鈥樼拋銈勭窗閻╁瓨甯磋ぐ鍗炴惙鐠侯垳鏁?閸樺缂夌拠顓濈疅閻ㄥ嫬顦婚柈銊︽降濠ф劧绱癭dsh-agent` 閻?`modelSelection`閵嗕梗dsh-session` 閻ㄥ嫪绨ㄦ禒鏈电瑢 surface 鐟欏嫬鍨妴涔sh-llm` 閻?`resolveModelInfo`/`defaultMaxTokens`閵嗕恭ordis 閻?service 鐟佸懘鍘ら妴鍌氱暊娴?*娑撳秴婀?*閺堫剝鐤嗛崫鍫濈瑖鐟曞棛娲婇懠鍐ㄦ纯閸愬懌鈧?
## 閸忣厹鈧焦鐣担娆撴閸?
- 闁繑妲戠€圭偘绶?Proxy 閺冪姵纭剁拠鍡楀焼閿?- `Object.create(prototype)` 閼充粙鈧俺绻冨Λ鈧弻銉礉娴ｅ棗鐣?*濞屸剝婀侀幍褑顢戦弸鍕偓鐘叉珤**閿涘苯鐤勬笟瀣摟濞堝吀绗岀粔浣规箒閻樿埖鈧礁褰查懗鑺ユ弓閸掓繂顫愰崠鏍电礉**娑撳秷鍏樻穱婵婄槈鐞涘奔璐熺粵澶夌幆**閿涘奔绮庣拋鏉跨秿娑撻缚闊╂禒鑺ヮ梾閺屻儲鐣担娆欑幢
- 婵炰浇鍎婂Ο鈥崇€烽梽鎰暰娑撴椽鍎寸純鍙夌磽缁夋眹鈧線鏁婇悧鍫滅贩鐠ф牓鈧礁鐤勬笟瀣╁悏鐟佸懌鈧焦鍓版径?monkey-patch閿涘奔绗夐弰顖涘Х瀵扳€叉崲閹板繑浼撻幇蹇氱箻缁嬪鍞存禒锝囩垳閻ㄥ嫭鐭欑粻渚库偓?
## 娑撳啨鈧線鍘ょ純?
```yaml
- id: restart-guard
  config:
    enabled: true
    dryRun: true
    proactive: false
    engineRouteMode: auto
    attestationPath: ''
    profileName: ''
    attestationMaxAgeMs: 86400000
    marginTokens: 32768
    assumedRatio: 2.0
    maxChunks: 6
    maxSummaryAttempts: 8
    maxTransportRetries: 3
    transportBackoffMs: 500
    transportBackoffMaxMs: 8000
    treatTransportAsOverflow: false
    transportOverflowConsecutive: 2
    maxRecoveryAttempts: 3
    summaryInstructionTokens: 4096
    summaryBudgetRatio: 0.75
    minTailNodes: 1
    logFile: ''
```

閸氼垰濮╅崳銊╂付鐠佸墽鐤?`DSH_RESTART_GUARD_ATTESTATION`閵嗕梗DSH_RESTART_GUARD_BOOT_ID`閿涘苯褰查柅?`DSH_PROFILE`閵?
## 閸忣偁鈧焦绁寸拠鏇礄114 妞ょ櫢绱?
| 婵傛ぞ娆?| 妞よ鏆?| 缁鐎?|
|---|---:|---|
| `selftest` | 13 | fake |
| `harness` | 13 | fake session閿涘矁闊╂禒鑺ユ暈閸?|
| `recovery-test` | 7 | fake |
| `transport-test` | 9 | fake |
| `route-test` | 25 | fake |
| `identity-test` | 15 | **閻喎鐤勭猾?+ 閻喎鐤勫Ο鈥虫健閺傚洣娆?+ 閻喎鐤勯崫鍫濈瑖 + 韫囶偆鍙庢径宥嗙壋** |
| `preflight-test` | 7 | **閻喎鐤勬０鍕梾閼存碍婀伴敍灞芥儓 asar 娑撳簼鍚夐柅鐘插冀娓?* |
| `real-api-test` 鑴? | 8 鑴? | **閻喎鐤?Session append** |
| `real-engine-test` | 9 | **閻喎鐤勭猾?+ 閻喎鐤?attestation + 閻喎鐤?summarize()** |

## 娑旀縿鈧礁鍑￠惌銉╂閸?
- unpacked CLI 瑜般垺鈧椒绗夐弨顖涘瘮閿?- 妫板嫭顥呴張顏呭复閸忋儱鎯庨崝銊ユ珤閿涘牊瀵滄潏鍦櫕娑撳秴浠涢敍澶涚幢
- 閺冪姷婀＄€?provider / 閻喎鐤?compactRegion / 閻喎鐤?token meter閿?- 楠炶泛褰?TRANSPORT 鐠佲剝鏆熼弮?request ID閿涙稑宕熼弶陇绉存０鍕暬濞戝牊浼呮稉宥呭讲閸樺绱遍柌宥嗘杹 IO 閺堫亙绱崠鏍モ偓?
## 妯″瀷鍒囨崲锛坴11锛?
妯″瀷鍒囨崲鏃讹紝DSH 鍘熺敓寮曟搸浼氬湪 `agent/request` 閲屻€佷换浣曡姹傚彂鍑轰箣鍓嶅帇缂╀細璇濓紙`compactPressure`锛夈€?`agent/pre-step` 涓ユ牸鏃╀簬璇?hook锛屽洜姝ゅ畧鍗湪 pre-step 璇嗗埆鍒囨崲骞舵彁鍓嶆仮澶嶏細

| 鍒ゅ畾 | 琛屼负 |
|---|---|
| `same`锛坧rovider 涓?model 閮界浉鍚岋級 | 鍘熻涓猴紝涓嶅彉 |
| `none`锛堟病鏈夋棫 header锛屾柊浼氳瘽棣栬疆锛?| 鍘熻涓猴紝涓嶅彉 |
| `unknown`锛堟湁 header 浣嗕换涓€渚х己璺敱瀛楁锛?| **reject**锛屼笉鐚?|
| `switch` + 瓒呰繃鏂版ā鍨嬬殑鐩爣澧?| 浠?`model-switch` trigger 鎵ц鎭㈠锛涙垚鍔熷悗瑕佹眰娴嬮噺涓ユ牸浣庝簬鍘熺敓闃堝€?|
| `switch` + 鏈秴澧?| 鏀捐锛堝師鐢熶篃浼氬洜浣庝簬闃堝€艰烦杩囷級 |
| `switch` + 鎭㈠澶辫触 / 浠嶉珮浜庡師鐢熼槇鍊?| **reject** |
| `switch` + `dryRun` | **reject**锛岀悊鐢?`dryRun_blocked_model_switch` |
| `switch` + `switchRecovery: false` | 鏀捐缁欏師鐢熷鐞嗭紙鍥炴粴璺緞锛?|

reject 閫氳繃 pre-step 鐨?`{kind:'reject'}` 鍐崇瓥瀹炵幇锛氫笉杩涘叆 `prepareRequest`锛屽洜姝や笉鍙兘瑙﹀彂鍘熺敓鍘嬬缉锛屼篃涓嶄細鐣欎笅鍗婃彁浜や簨鍔°€?
闃堝€煎鏍告寜鍘熺敓鍏紡锛坄floor(min(window脳thresholdRatio, window鈭抮eserved鈭抙eadroom))`锛夎绠楋紝骞剁敤涓庡師鐢熺浉鍚岀殑 header 鍙ｅ緞閲嶆柊娴嬮噺銆
## 请求字符预算（v12）

除 token 墙外，守卫还检查估算的请求体字符数（JS `string.length`，不是 UTF-8 字节）：

```
estimatedChars = JSON.stringify(projectedMessages).length + JSON.stringify(tools).length + 65536
estimateWithMargin = ceil(estimatedChars * 1.10)
charsOK = estimateWithMargin <= requestCharsBudget
```

- `requestCharsBudget` 默认 `1_800_000`，是实验起点，不是已校准的硬上限；
- `requestCharsBudget: 0` 关闭检查，行为与 v11 完全一致；
- `toolHistory` 不单独计入（它只改写 developer 消息与工具声明，已含在投影消息里）；
- 日志区分 `estimatedChars`、`estimateWithMargin`、fetch `bodyLength` 与 UTF-8 字节，不混用。

每块提交后重新投影、重新估算；token 与字符两项都满足才进入原有的 nativeThreshold 复核与放行。