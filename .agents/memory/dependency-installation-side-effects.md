---
name: Dependency installation side effects
description: Environment-specific changes that can accompany package installation.
---

Package installation in this workspace may rewrite lockfile registry metadata and add a port mapping to the project configuration even when those changes are not part of the requested work.

**Why:** Keeping those incidental changes can create unrelated diffs or alter how the imported project is exposed.

**How to apply:** After installing dependencies, inspect the diff and retain only dependency changes that are intentionally part of the task.