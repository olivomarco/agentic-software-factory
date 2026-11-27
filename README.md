# software-factory-advanced

Dummy todo app used to exercise an advanced SDLC factory on GitHub primitives:
issues are triaged and grilled into specs, a human approves the spec, the spec
is split into dependent sub-issues, the Copilot cloud agent implements them on
a per-spec branch and a risk gate merges small changes on its own while
sending risky ones and every finished feature to a human.

- How the factory works, setup, gates and risk policy: [docs/factory.md](docs/factory.md)
- Copilot CLI cockpit canvas: [.github/extensions/factory-cockpit/README.md](.github/extensions/factory-cockpit/README.md)
- Contributor and agent instructions: [AGENTS.md](AGENTS.md), [CODING_STANDARDS.md](CODING_STANDARDS.md)
- Skills: [.github/skills/README.md](.github/skills/README.md) (from mattpocock/skills, MIT)
