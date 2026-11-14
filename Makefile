# Written in GNU Make 4.3 syntax, the version of the GitHub ubuntu-24.04
# runner and of the node:22 image. Newer make versions run it as well; when
# you change this file, use only syntax and functions that GNU Make 4.3 has.
# The recipes need a POSIX shell: Linux, macOS, WSL or Git Bash. `make` alone
# lists the targets with the text after their "##".

SHELL := /bin/sh
.SHELLFLAGS := -ec
.ONESHELL:

VERSIONS ?= $(shell tr -d '\r' < .github/workflows/test.yml | sed -n 's/^ *node: \[\(.*\)\]$$/\1/p' | tr -d ',')
UNDICI_VERSIONS ?= $(shell tr -d '\r' < .github/workflows/test.yml | sed -n 's/^ *undici-node: \[\(.*\)\]$$/\1/p' | tr -d ',')
GOT_VERSIONS ?= $(shell tr -d '\r' < .github/workflows/test.yml | sed -n 's/^ *got-node: \[\(.*\)\]$$/\1/p' | tr -d ',')
IMPIT_VERSIONS ?= $(shell tr -d '\r' < .github/workflows/test.yml | sed -n 's/^ *impit-node: \[\(.*\)\]$$/\1/p' | tr -d ',')
PARITY_SUITE_REPOSITORY ?= $(shell tr -d '\r' < .github/workflows/parity.yml | sed -n 's/^ *PARITY_SUITE_REPOSITORY: *\([^ ]*\)$$/\1/p')
PARITY_SUITE_COMMIT ?= $(shell tr -d '\r' < .github/workflows/parity.yml | sed -n 's/^ *PARITY_SUITE_COMMIT: *\([0-9a-f]*\)$$/\1/p')
PARITY_TARGETS ?= core got undici impit
PARITY_NODE ?= 22
NPM_INSTALL := npm install --ignore-scripts --no-package-lock --no-audit --no-fund --legacy-peer-deps --loglevel=error

# $(call in_node,<node version>,<npm scripts>): copy the repository without
# node_modules into a node:<version> container, install and run the scripts.
define in_node
docker run --rm -v "$(CURDIR):/src:ro" "node:$(1)" sh -ec '
  mkdir /app && tar -C /src --exclude=./node_modules -cf - . | tar -C /app -xf - && cd /app
  node -v && npm -v
  $(NPM_INSTALL)
  for script in $(2); do npm run "$$script"; done'
endef

# $(call engine_in_node,<engine>,<node versions>): run `make install-<engine>
# test-<engine>` on a copy of the repository in node:<version> containers.
define engine_in_node
status=0
for version in $(2); do
  echo "== node:$$version"
  docker run --rm -v "$(CURDIR):/src:ro" "node:$$version" sh -ec '
    mkdir /app && tar -C /src --exclude=./node_modules --exclude=./packages/$(1)/node_modules -cf - . | tar -C /app -xf - && cd /app
    node -v && npm -v
    $(NPM_INSTALL)
    make install-$(1) test-$(1)' || status=1
done
exit $$status
endef

.DEFAULT_GOAL := help

.PHONY: help install install-undici install-got install-impit test test-undici test-got test-impit lint test-cov check-original-tests test-in-docker test-undici-in-docker test-got-in-docker test-impit-in-docker lint-in-docker release-notes publish

help: ## this list
	@awk '/^[a-z][a-zA-Z0-9_-]*:/ { name = substr($$0, 1, index($$0, ":") - 1); text = index($$0, "## ") ? substr($$0, index($$0, "## ") + 3) : ""; printf "make %-22s %s\n", name, text }' $(firstword $(MAKEFILE_LIST))

install: ## install the dependencies like CI does
	$(NPM_INSTALL)

install-undici: ## install the undici engine package with the core linked from this checkout
	@cd packages/undici && npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund --loglevel=error ../..

install-got: ## install the got engine package with the core linked from this checkout
	@cd packages/got && npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund --loglevel=error ../..

install-impit: ## install the impit engine package with the core linked from this checkout
	@cd packages/impit && npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund --loglevel=error ../..

# Node 16 and older are built with OpenSSL 1.x and fail on the OpenSSL 3
# configuration of current Linux systems ("DSO support routines"); they get
# an empty configuration instead. Windows has no such system configuration.
test: ## tests on the Node you have, like each CI job
	@if [ "$(OS)" != Windows_NT ] && node -p process.versions.openssl | grep -q '^1\.'; then
	  export OPENSSL_CONF=/dev/null
	fi
	npm run test-ci

test-undici: ## engine tests and the core suite through undici on the Node you have (>= 22.19)
	@node node_modules/tape/bin/tape 'packages/undici/tests/test-*.js'
	node packages/undici/tests/run-core-suite.js

test-got: ## engine tests and the core suite through got on the Node you have (>= 22.12)
	@node node_modules/tape/bin/tape 'packages/got/tests/test-*.js'
	node packages/got/tests/run-core-suite.js

test-impit: ## engine tests and the core suite through impit on the Node you have (>= 20)
	@node node_modules/tape/bin/tape 'packages/impit/tests/test-*.js'
	node packages/impit/tests/run-core-suite.js

lint: ## lint, like CI
	npm run lint

test-cov: ## tests with a coverage report in coverage/
	npm run test-cov

check-original-tests: ## fail when a test file of request 2.88.2 is gone, like CI
	@git diff --stat --no-renames 3c0cddc HEAD -- 'tests/test-*.js'
	deleted=$$(git diff --name-only --no-renames --diff-filter=D 3c0cddc HEAD -- tests)
	if [ -n "$$deleted" ]; then
	  echo "Deleted test files of request 2.88.2: $$deleted"
	  exit 1
	fi

test-in-docker: ## tests in node:<version> containers; VERSIONS="6 26", default: the CI matrix
	@test -n "$(strip $(VERSIONS))" || { echo 'no Node versions: set VERSIONS or check the matrix in .github/workflows/test.yml'; exit 2; }
	status=0
	for version in $(VERSIONS); do
	  echo "== node:$$version"
	  $(call in_node,$$version,test-ci) || status=1
	done
	exit $$status

test-undici-in-docker: ## test-undici in node:<version> containers; UNDICI_VERSIONS="22 26"
	@test -n "$(strip $(UNDICI_VERSIONS))" || { echo 'no Node versions: set UNDICI_VERSIONS or check the undici-node matrix in .github/workflows/test.yml'; exit 2; }
	status=0
	for version in $(UNDICI_VERSIONS); do
	  echo "== node:$$version"
	  docker run --rm -v "$(CURDIR):/src:ro" "node:$$version" sh -ec '
	    mkdir /app && tar -C /src --exclude=./node_modules --exclude=./packages/undici/node_modules -cf - . | tar -C /app -xf - && cd /app
	    node -v && npm -v
	    $(NPM_INSTALL)
	    make install-undici test-undici' || status=1
	done
	exit $$status

test-got-in-docker: ## test-got in node:<version> containers; GOT_VERSIONS="22 26"
	@test -n "$(strip $(GOT_VERSIONS))" || { echo 'no Node versions: set GOT_VERSIONS or check the got-node matrix in .github/workflows/test.yml'; exit 2; }
	$(call engine_in_node,got,$(GOT_VERSIONS))

test-impit-in-docker: ## test-impit in node:<version> containers; IMPIT_VERSIONS="20 26"
	@test -n "$(strip $(IMPIT_VERSIONS))" || { echo 'no Node versions: set IMPIT_VERSIONS or check the impit-node matrix in .github/workflows/test.yml'; exit 2; }
	$(call engine_in_node,impit,$(IMPIT_VERSIONS))

# The promise parity suite of request-got-adapter (Jest) compares request-promise-native 1.0.9 on
# request 2.88.2 with request-promise-native 1.0.9 on each target: the core and the engine packages,
# packed from this checkout, each engine with the core of this checkout. The suite's repository and
# commit are set in .github/workflows/parity.yml; tests/parity/expected/<target>.json lists the
# tests that fail by a documented difference of that target.
.PHONY: parity parity-in-docker

parity: ## the promise parity suite on the Node you have (>= 22); PARITY_TARGETS="core got", PARITY_SUITE=<checkout>, PARITY_OUT=<dir>
	@PARITY_TARGETS="$(PARITY_TARGETS)" PARITY_SUITE="$(PARITY_SUITE)" PARITY_SUITE_REPOSITORY="$(PARITY_SUITE_REPOSITORY)" \
	  PARITY_SUITE_COMMIT="$(PARITY_SUITE_COMMIT)" PARITY_OUT="$(PARITY_OUT)" PARITY_WORK="$(PARITY_WORK)" node tests/parity/run.js

parity-in-docker: ## parity in a node:<PARITY_NODE> container, default 22; PARITY_TARGETS="core got", PARITY_OUT=<dir> keeps the results
	@out=
	if [ -n "$(PARITY_OUT)" ]; then
	  mkdir -p "$(PARITY_OUT)"
	  out='-v $(abspath $(PARITY_OUT)):/out'
	fi
	docker run --rm -v "$(CURDIR):/src:ro" $$out "node:$(PARITY_NODE)" sh -ec '
	  mkdir /app && tar -C /src --exclude=./node_modules --exclude="./packages/*/node_modules" -cf - . | tar -C /app -xf - && cd /app
	  node -v && npm -v
	  make parity PARITY_TARGETS="$(PARITY_TARGETS)" $(if $(PARITY_OUT),PARITY_OUT=/out)'

lint-in-docker: ## lint in a node:22 container
	@$(call in_node,22,lint)

release-notes: ## the CHANGELOG lines of TAG=v<version>
	@test -n "$(TAG)" || { echo 'usage: make release-notes TAG=v<version>'; exit 2; }
	notes=$$(awk -v heading='### $(TAG) ' 'index($$0, heading) == 1 { found = 1; next } /^### / { if (found) exit } found' CHANGELOG.md)
	if [ -z "$$(printf '%s' "$$notes" | tr -d '[:space:]')" ]; then
	  echo "CHANGELOG.md has no lines under a '### $(TAG) (YYYY/MM/DD)' heading" >&2
	  exit 1
	fi
	printf '%s\n' "$$notes"

publish: ## npm publish and GitHub release of TAG=v<version>, each skipped if it exists; run by release.yml
	@test -n "$(TAG)" || { echo 'usage: make publish TAG=v<version>'; exit 2; }
	version=$$(node -p "require('./package.json').version")
	if [ "$(TAG)" != "v$$version" ]; then
	  echo "Tag $(TAG) does not match the package.json version $$version"
	  exit 1
	fi
	notes_file=$$(mktemp)
	$(MAKE) --no-print-directory -s release-notes TAG=$(TAG) > "$$notes_file"
	dist_tag=latest
	prerelease=
	case "$$version" in *-*) dist_tag=next; prerelease=--prerelease ;; esac
	name=$$(node -p "require('./package.json').name")
	if [ "$$(npm view "$$name@$$version" version 2>/dev/null)" = "$$version" ]; then
	  echo "$$name@$$version is already on npm"
	else
	  npm publish --access public --tag "$$dist_tag" --ignore-scripts
	fi
	if gh release view "$(TAG)" >/dev/null 2>&1; then
	  echo "GitHub release $(TAG) already exists"
	else
	  gh release create "$(TAG)" --title "$(TAG)" --target "$$(git rev-parse HEAD)" --notes-file "$$notes_file" $$prerelease
	fi
