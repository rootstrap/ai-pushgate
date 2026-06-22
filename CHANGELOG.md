# Changelog

## [3.4.0](https://github.com/rootstrap/ai-pushgate/compare/v3.3.1...v3.4.0) (2026-06-22)


### Features

* add gitleaks plugin integration ([#49](https://github.com/rootstrap/ai-pushgate/issues/49)) ([ad085c1](https://github.com/rootstrap/ai-pushgate/commit/ad085c1ff8c10a9c4f59bb23cc33d9cb3415a65f))

## [3.3.1](https://github.com/rootstrap/ai-pushgate/compare/v3.3.0...v3.3.1) (2026-06-18)


### Bug Fixes

* enhance JSON parsing and validation in AI review output ([#37](https://github.com/rootstrap/ai-pushgate/issues/37)) ([f4ec545](https://github.com/rootstrap/ai-pushgate/commit/f4ec545409a414fb75188effc8c27003faa21024))

## [3.3.0](https://github.com/rootstrap/ai-pushgate/compare/v3.2.0...v3.3.0) (2026-06-15)


### Features

* add GitHub Copilot AI provider ([#34](https://github.com/rootstrap/ai-pushgate/issues/34)) ([9c33155](https://github.com/rootstrap/ai-pushgate/commit/9c33155c1ebe6819cd674c62e064f8233c510000))

## [3.2.0](https://github.com/rootstrap/ai-pushgate/compare/v3.1.0...v3.2.0) (2026-06-14)


### Features

* normalize structured AI review output ([#32](https://github.com/rootstrap/ai-pushgate/issues/32)) ([4c2d05f](https://github.com/rootstrap/ai-pushgate/commit/4c2d05fd0751b4490be3c92b2ba50cd8787d92df))

## [3.1.0](https://github.com/rootstrap/ai-pushgate/compare/v3.0.0...v3.1.0) (2026-06-08)


### Features

* add local AI provider interface and Claude adapter ([#29](https://github.com/rootstrap/ai-pushgate/issues/29)) ([8d95e23](https://github.com/rootstrap/ai-pushgate/commit/8d95e23f62c62596cb95b3cceb09cd04946c87a6))

## [3.0.0](https://github.com/rootstrap/ai-pushgate/compare/v2.2.0...v3.0.0) (2026-06-08)


### ⚠ BREAKING CHANGES

* Claude Code CLI is now mandatory and has to be installed to use the hook.

### Features

* add v2 config schema validation ([#20](https://github.com/rootstrap/ai-pushgate/issues/20)) ([8e262e7](https://github.com/rootstrap/ai-pushgate/commit/8e262e7e9184a0bb9c833ce3f5610c817c7c20f3))
* check for version updates on hook run ([6354834](https://github.com/rootstrap/ai-pushgate/commit/6354834a8b684e0b04285c991e897c12ed009ecc))
* display hook version upon installation ([452e766](https://github.com/rootstrap/ai-pushgate/commit/452e766301846e26932e674046b654677350ac4d))
* enhance pre-push error handling and output reporting ([#24](https://github.com/rootstrap/ai-pushgate/issues/24)) ([c046e31](https://github.com/rootstrap/ai-pushgate/commit/c046e3166e5b4a013ffd80dd529fad86a3783053))
* implement changed-file path policy and resolver for Git diffs ([#25](https://github.com/rootstrap/ai-pushgate/issues/25)) ([983cd2b](https://github.com/rootstrap/ai-pushgate/commit/983cd2ba0acbfc2c98046ad6e072eae2148c32fd))
* implement local skip controls ([#28](https://github.com/rootstrap/ai-pushgate/issues/28)) ([37a1243](https://github.com/rootstrap/ai-pushgate/commit/37a1243a5bdba44f0fd01aa06f35b809ca6c4b2a))
* initial commit ([e035cf1](https://github.com/rootstrap/ai-pushgate/commit/e035cf17f71909cbc47d103d9f759c915d7fe413))
* update installation instructions in README and product contract documentation ([#17](https://github.com/rootstrap/ai-pushgate/issues/17)) ([e60ae7b](https://github.com/rootstrap/ai-pushgate/commit/e60ae7bd217c5315180f1d4a698ece114b4ec791))
* update README and add product contract documentation for Pushgate ([#16](https://github.com/rootstrap/ai-pushgate/issues/16)) ([0c76c5e](https://github.com/rootstrap/ai-pushgate/commit/0c76c5e9c7999d335e547c7c43d64629f09f4504))


### Bug Fixes

* **node template:** add covered file extensions ([1e3a256](https://github.com/rootstrap/ai-pushgate/commit/1e3a25645febb59e2e8bf78088051a9663914bdd))
* **pre-push:** clarify category usage in findings response format ([b20acb4](https://github.com/rootstrap/ai-pushgate/commit/b20acb4b279d86fa313cbd55d096670f89d3b33b))
* **pre-push:** enhance review instructions for better context access ([bd7c3d1](https://github.com/rootstrap/ai-pushgate/commit/bd7c3d1e478cfa55b6c737f780f46096d7304ab0))
* show more informative logs when Claude CLI is not installed ([5ff8df4](https://github.com/rootstrap/ai-pushgate/commit/5ff8df4b48f10e3b8bef612fc131062d64ba289c))
* update release configuration ([5ee951e](https://github.com/rootstrap/ai-pushgate/commit/5ee951e354a7b01605719400e2e9e897e4a4bcb2))


### Code Refactoring

* enhance install script with structured comments and checks ([99a25be](https://github.com/rootstrap/ai-pushgate/commit/99a25be12c22c1330e1f0e7636e5875541b17e04))

## [2.2.0](https://github.com/rootstrap/ai-git-hooks/compare/v2.1.2...v2.2.0) (2026-04-08)


### Features

* display hook version upon installation ([452e766](https://github.com/rootstrap/ai-git-hooks/commit/452e766301846e26932e674046b654677350ac4d))

## [2.1.2](https://github.com/rootstrap/ai-git-hooks/compare/v2.1.1...v2.1.2) (2026-04-08)


### Bug Fixes

* update release configuration ([5ee951e](https://github.com/rootstrap/ai-git-hooks/commit/5ee951e354a7b01605719400e2e9e897e4a4bcb2))

## [2.1.1](https://github.com/rootstrap/ai-git-hooks/compare/v2.1.0...v2.1.1) (2026-04-07)


### Bug Fixes

* **pre-push:** enhance review instructions for better context access ([bd7c3d1](https://github.com/rootstrap/ai-git-hooks/commit/bd7c3d1e478cfa55b6c737f780f46096d7304ab0))

## [2.1.0](https://github.com/rootstrap/ai-git-hooks/compare/v2.0.0...v2.1.0) (2026-04-07)


### Features

* check for version updates on hook run ([6354834](https://github.com/rootstrap/ai-git-hooks/commit/6354834a8b684e0b04285c991e897c12ed009ecc))


### Bug Fixes

* **node template:** add covered file extensions ([1e3a256](https://github.com/rootstrap/ai-git-hooks/commit/1e3a25645febb59e2e8bf78088051a9663914bdd))
* **pre-push:** clarify category usage in findings response format ([b20acb4](https://github.com/rootstrap/ai-git-hooks/commit/b20acb4b279d86fa313cbd55d096670f89d3b33b))
* show more informative logs when Claude CLI is not installed ([5ff8df4](https://github.com/rootstrap/ai-git-hooks/commit/5ff8df4b48f10e3b8bef612fc131062d64ba289c))

## [2.0.0](https://github.com/rootstrap/ai-git-hooks/compare/v1.0.0...v2.0.0) (2026-03-20)


### ⚠ BREAKING CHANGES

* Claude Code CLI is now mandatory and has to be installed to use the hook.

### Code Refactoring

* enhance install script with structured comments and checks ([99a25be](https://github.com/rootstrap/ai-git-hooks/commit/99a25be12c22c1330e1f0e7636e5875541b17e04))
