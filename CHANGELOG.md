# Changelog

## 1.0.0 (2026-11-26)


### Features

* add Codex plugin and durable agent delivery ([#40](https://github.com/tornado1110/tigercat/issues/40)) ([13e9559](https://github.com/tornado1110/tigercat/commit/13e95599062cd8e181a5cb46f53e22d53e247a22))
* add local Feishu personal assistant tracking ([c7d3caf](https://github.com/tornado1110/tigercat/commit/c7d3cafb61f25df0a53f09b7cdc25b4f343654e7))
* add native Feishu messaging channel ([45d526f](https://github.com/tornado1110/tigercat/commit/45d526f021d7fc201d62cf92270e7bd4f7d6290f))
* add week-1 super-agent router skeleton ([48798bd](https://github.com/tornado1110/tigercat/commit/48798bd57ddb586148403317339e398b3c672b42))
* add week-1 super-agent router skeleton ([c5b53a1](https://github.com/tornado1110/tigercat/commit/c5b53a1c73ef66f07549b7f033c92dcc3af55562))
* bind a Feishu bot in one step and launch its local Worker ([7753cea](https://github.com/tornado1110/tigercat/commit/7753cea50e3de62708d8081e2254e86768eef2a8))
* drive claude-code and codex workers over ACP ([de80964](https://github.com/tornado1110/tigercat/commit/de8096489cc6f222c33c2435b18ce0746ceee9bd))
* drive claude-code and codex workers over ACP ([25e0d98](https://github.com/tornado1110/tigercat/commit/25e0d9828bb4ee0d620bce761b416c06e9757243))
* expose worker workspace metadata from read ([71a9deb](https://github.com/tornado1110/tigercat/commit/71a9debe124d3af8cfd0ba9c26922a201d4a3dba))
* **filter:** add ja/ko/es default stop words ([3f3caa2](https://github.com/tornado1110/tigercat/commit/3f3caa2c404b4cd5212e14f527a71cc7c4deb620))
* guide router toward proactive dispatch ([65efd03](https://github.com/tornado1110/tigercat/commit/65efd03865f221a713407606238b9f419daef2d3))
* make coordinator proactively dispatch workers ([a6921a6](https://github.com/tornado1110/tigercat/commit/a6921a6fcae992296dbd327a7309b792937aad39))
* make coordinator proactively dispatch workers ([43875c4](https://github.com/tornado1110/tigercat/commit/43875c4913fd66c2939e9f025b29e8849c0af7d4))
* react to each accepted Feishu message on receipt ([b115946](https://github.com/tornado1110/tigercat/commit/b115946e566af0509b47201b1905c0ad0d4226c3))
* report worker branches and pull request links ([9de1844](https://github.com/tornado1110/tigercat/commit/9de184480328790dd0b736a5f2b944019394a16a))
* restore worker sessions across restart when session/load works ([3e47ecb](https://github.com/tornado1110/tigercat/commit/3e47ecbcc85b8a13ef30aeaad7657d185e6384e9)), closes [#13](https://github.com/tornado1110/tigercat/issues/13) [#19](https://github.com/tornado1110/tigercat/issues/19)
* **router:** call DeepSeek chat completions for tool routing ([6c9354f](https://github.com/tornado1110/tigercat/commit/6c9354fc1ece328f6252991bb4fbddee5e6bf8a6))
* **router:** deliver a finished worker through cc-connect send ([f1b5eb8](https://github.com/tornado1110/tigercat/commit/f1b5eb851d20d9561ea1d87fcd03e2a8e6898e1b))
* show project, runtime and session model on Feishu reply cards ([2a4bc6b](https://github.com/tornado1110/tigercat/commit/2a4bc6b2fc1d49c2bc60e031945a79ccb628ebe8))
* steer Feishu follow-ups into the active Worker turn ([212c45a](https://github.com/tornado1110/tigercat/commit/212c45a54c9cdcd2c11920279d5bceb81f5daa6a))


### Bug Fixes

* cover stdio stubs and version the admission policy ([bc962ff](https://github.com/tornado1110/tigercat/commit/bc962ffa745935deedf189c1c877f4535e275160))
* detect translation source updates without translated content ([f49f897](https://github.com/tornado1110/tigercat/commit/f49f897169b6f7cf0c73aad3fd0f26bdcd0ac54a))
* do not restore built-in sessions on restart ([8fc7ea9](https://github.com/tornado1110/tigercat/commit/8fc7ea9a7309db511880bd221aab2e9779a6559a)), closes [#13](https://github.com/tornado1110/tigercat/issues/13) [#19](https://github.com/tornado1110/tigercat/issues/19)
* **engine:** stop settle from polling a real timer ([98d0433](https://github.com/tornado1110/tigercat/commit/98d04336e695bc28de9ebab7117b642c891b91b5))
* exit tigercat acp when the client closes stdin ([c9557f3](https://github.com/tornado1110/tigercat/commit/c9557f3f6ef42569a958e6f5631a6e95ec5263ed))
* keep raw Feishu SDK diagnostics out of logs ([b1f6d03](https://github.com/tornado1110/tigercat/commit/b1f6d037a254a8db02941a1864def3dd3ab68e43))
* kill worker descendants before the parent process ([cae518b](https://github.com/tornado1110/tigercat/commit/cae518b82d37d4caf65ee617fce6e76c9de8ac81))
* label the channel base directory as its workspace ([caed6b3](https://github.com/tornado1110/tigercat/commit/caed6b3ee1bf272b72a3f33172185721d553fbf2))
* mark an in-flight worker lost after restart ([fd382e9](https://github.com/tornado1110/tigercat/commit/fd382e99e7aa758bdc68af1695b729a2d0814df0))
* parse read() changed files and rename related.cwd ([a430825](https://github.com/tornado1110/tigercat/commit/a430825e98d019d5e3ea9f7ee7222c1067b5aca3))
* **process:** locate taskkill when PATH does not include System32 ([eda9b88](https://github.com/tornado1110/tigercat/commit/eda9b889a5ca40b879b797c81e760ead6762fef2)), closes [#28](https://github.com/tornado1110/tigercat/issues/28)
* **process:** reap Windows descendants before kill() resolves ([e8cb76b](https://github.com/tornado1110/tigercat/commit/e8cb76bd8733012de9a3a04cbca9bd494df707e9)), closes [#28](https://github.com/tornado1110/tigercat/issues/28)
* **process:** spawn npx through node on Windows ([d0d9182](https://github.com/tornado1110/tigercat/commit/d0d91825bfdc4770d76043a9d9e7bc45c67de18c))
* read Git status paths without shell-style parsing ([e36c24c](https://github.com/tornado1110/tigercat/commit/e36c24cd99e40b0a84f4bee2760605789de6728d))
* refuse Codex plugin startup while native router tools remain ([0f079dd](https://github.com/tornado1110/tigercat/commit/0f079dd79d1c29389a002debe75877b7fb9bda03)), closes [#61](https://github.com/tornado1110/tigercat/issues/61)
* restore allowlisted adapters without replaying session history ([d875e15](https://github.com/tornado1110/tigercat/commit/d875e15d871661be173b6158645e5e0ca1f5271d)), closes [#71](https://github.com/tornado1110/tigercat/issues/71)
* **security:** redact secrets in logs ([1c731f7](https://github.com/tornado1110/tigercat/commit/1c731f795e3f9e89d31b910dd59d651c98bdea77))
* stop an in-flight turn from undoing kill ([99e7c51](https://github.com/tornado1110/tigercat/commit/99e7c51bb97575c86fa031e8c39b04c67e6e674f))
* suppress late worker results while kill is pending ([3ccf1c7](https://github.com/tornado1110/tigercat/commit/3ccf1c70a32fd883b1b8f3623c4669705ba19d15))
* wait for taskkill before releasing a worker directory ([6830ce1](https://github.com/tornado1110/tigercat/commit/6830ce14ccc28508d61c3693e1ea2448e3030e1b))
* wait for worker processes to exit before deleting their directories ([b5d10f9](https://github.com/tornado1110/tigercat/commit/b5d10f9d81eb3150b656bca911e3ebe4a40aa474))


### Performance Improvements

* trim MCP tool context ([21e01ab](https://github.com/tornado1110/tigercat/commit/21e01abc78c6508692604f2b95594f574c0bcfeb))
* trim MCP tool context ([8502f99](https://github.com/tornado1110/tigercat/commit/8502f992274bddfb9907859d8d1d68269d1f2c49))
