# Written in GNU Make 4.3 syntax, the version of the GitHub ubuntu-24.04
# runner and of the node:22 image. Newer make versions run it as well; when
# you change this file, use only syntax and functions that GNU Make 4.3 has.
# The recipes need a POSIX shell: Linux, macOS, WSL or Git Bash. `make` alone
# lists the targets with the text after their "##".

SHELL := /bin/sh
.SHELLFLAGS := -ec
.ONESHELL:

VERSIONS ?= $(shell tr -d '\r' < .github/workflows/test.yml | sed -n 's/^ *node: \[\(.*\)\]$$/\1/p' | tr -d ',')
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

.DEFAULT_GOAL := help

.PHONY: help install test lint test-cov check-original-tests test-in-docker lint-in-docker release-notes publish

help: ## this list
	@awk '/^[a-z][a-zA-Z0-9_-]*:/ { name = substr($$0, 1, index($$0, ":") - 1); text = index($$0, "## ") ? substr($$0, index($$0, "## ") + 3) : ""; printf "make %-22s %s\n", name, text }' $(firstword $(MAKEFILE_LIST))

install: ## install the dependencies like CI does
	$(NPM_INSTALL)

# Node 16 and older are built with OpenSSL 1.x and fail on the OpenSSL 3
# configuration of current Linux systems ("DSO support routines"); they get
# an empty configuration instead. Windows has no such system configuration.
test: ## tests on the Node you have, like each CI job
	@if [ "$(OS)" != Windows_NT ] && node -p process.versions.openssl | grep -q '^1\.'; then
	  export OPENSSL_CONF=/dev/null
	fi
	npm run test-ci

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
