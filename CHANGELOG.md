# Changelog

## 1.0.0 (2026-11-20)


### Features

* add Codex plugin and durable agent delivery ([#40](https://github.com/tornado1110/tigercat/issues/40)) ([13e9559](https://github.com/tornado1110/tigercat/commit/13e95599062cd8e181a5cb46f53e22d53e247a22))
* add week-1 super-agent router skeleton ([48798bd](https://github.com/tornado1110/tigercat/commit/48798bd57ddb586148403317339e398b3c672b42))
* add week-1 super-agent router skeleton ([c5b53a1](https://github.com/tornado1110/tigercat/commit/c5b53a1c73ef66f07549b7f033c92dcc3af55562))
* drive claude-code and codex workers over ACP ([de80964](https://github.com/tornado1110/tigercat/commit/de8096489cc6f222c33c2435b18ce0746ceee9bd))
* drive claude-code and codex workers over ACP ([25e0d98](https://github.com/tornado1110/tigercat/commit/25e0d9828bb4ee0d620bce761b416c06e9757243))
* **filter:** add ja/ko/es default stop words ([3f3caa2](https://github.com/tornado1110/tigercat/commit/3f3caa2c404b4cd5212e14f527a71cc7c4deb620))
* **router:** call DeepSeek chat completions for tool routing ([6c9354f](https://github.com/tornado1110/tigercat/commit/6c9354fc1ece328f6252991bb4fbddee5e6bf8a6))
* **router:** deliver a finished worker through cc-connect send ([f1b5eb8](https://github.com/tornado1110/tigercat/commit/f1b5eb851d20d9561ea1d87fcd03e2a8e6898e1b))


### Bug Fixes

* cover stdio stubs and version the admission policy ([bc962ff](https://github.com/tornado1110/tigercat/commit/bc962ffa745935deedf189c1c877f4535e275160))
* **engine:** stop settle from polling a real timer ([98d0433](https://github.com/tornado1110/tigercat/commit/98d04336e695bc28de9ebab7117b642c891b91b5))
* exit tigercat acp when the client closes stdin ([c9557f3](https://github.com/tornado1110/tigercat/commit/c9557f3f6ef42569a958e6f5631a6e95ec5263ed))
* kill worker descendants before the parent process ([cae518b](https://github.com/tornado1110/tigercat/commit/cae518b82d37d4caf65ee617fce6e76c9de8ac81))
* **process:** locate taskkill when PATH does not include System32 ([eda9b88](https://github.com/tornado1110/tigercat/commit/eda9b889a5ca40b879b797c81e760ead6762fef2)), closes [#28](https://github.com/tornado1110/tigercat/issues/28)
* **process:** reap Windows descendants before kill() resolves ([e8cb76b](https://github.com/tornado1110/tigercat/commit/e8cb76bd8733012de9a3a04cbca9bd494df707e9)), closes [#28](https://github.com/tornado1110/tigercat/issues/28)
* **process:** spawn npx through node on Windows ([d0d9182](https://github.com/tornado1110/tigercat/commit/d0d91825bfdc4770d76043a9d9e7bc45c67de18c))
* **security:** redact secrets in logs ([1c731f7](https://github.com/tornado1110/tigercat/commit/1c731f795e3f9e89d31b910dd59d651c98bdea77))
* wait for taskkill before releasing a worker directory ([6830ce1](https://github.com/tornado1110/tigercat/commit/6830ce14ccc28508d61c3693e1ea2448e3030e1b))
* wait for worker processes to exit before deleting their directories ([b5d10f9](https://github.com/tornado1110/tigercat/commit/b5d10f9d81eb3150b656bca911e3ebe4a40aa474))
