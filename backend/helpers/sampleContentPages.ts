import type { SamplePage } from '../models/sampleContent.ts'

const PREFIX = 'welcome/'

export const WELCOME_SAMPLE_PAGES: SamplePage[] = [
  {
    path: `${PREFIX}start-here`,
    title: 'Welcome to Cardinal.js',
    tags: ['welcome'],
    content: `This space is sample content. Each page shows one thing that sets Cardinal.js apart, with the settings to look at when you want to try it yourself.

Every page here carries the \`cardinal-sample-content\` tag and lives under \`welcome/\`, so an administrator can remove the whole set in one step without touching anything you wrote yourself.

## Take the tour

- [Page rules _Decide who can read, write and manage which pages, and how conflicts resolve._](/welcome/page-rules)
- [Approvals _Let readers suggest edits and have a reviewer sign them off before they land._](/welcome/approvals)
- [A classified page _Give a page a sensitivity level that follows it around the tree._](/welcome/classified-page)
- [A glossary term _Define a word once and get a hover definition everywhere it appears._](/welcome/glossary-term)
- [Diagrams _Draw a flowchart from a few lines of text._](/welcome/diagram-block)
- [Connecting an AI agent _Point an MCP client at this wiki with a scoped token._](/welcome/mcp)
  {.links-list}

## Where to go next

Edit this page to try the editor, then create a page of your own. When you are done with the tour, an administrator can purge the sample content from the admin area.
`
  },
  {
    path: `${PREFIX}page-rules`,
    title: 'Page Rules',
    tags: ['welcome', 'page-rules'],
    content: `Access in Cardinal.js is granted by **rules**, and rules belong to groups. Nothing is granted by default: if no rule names a permission for a page, that permission is denied.

## What a rule says

A rule sits on a group (**Admin → Groups**, then the group's **Rules** section) and combines three things:

- **Permissions**, the exact names the rule grants, such as \`read:pages\` or \`write:pages\`.
- **Which pages** it addresses, using one of the match kinds below.
- **A mode**: Allow, Deny or Force Allow.

A rule can also be limited to particular locales or sites. Leaving either empty means all of them. A person's rules are everything their groups say, pooled together.

## Match kinds

| Match                 | Addresses a page when                            |
| --------------------- | ------------------------------------------------ |
| Path Starts With...   | its path begins with the text                    |
| Path Ends With...     | its path ends with the text                      |
| Path Matches Regex... | its path matches the regular expression          |
| Has Any Tag...        | it carries at least one of the tags              |
| Has All Tags...       | it carries every one of the tags                 |
| Path Is Exactly...    | its path is exactly the text                     |
| Has Classification... | it is at one of the chosen classification levels |

## Which rule wins

When several rules name the same permission and match the same page, exactly one decides. The order in which you wrote them means nothing. Each step only breaks a tie left by the one before:

1. **Kind**, weakest to strongest: path starts, ends or regex; then tags; then an exact path; then classification.
2. **Path length**, so \`docs/handbook\` beats \`docs\`, and a rule for the whole site is the weakest of all.
3. **Match type** within a kind, such as all tags beating any tag.
4. **Mode**: Deny beats Allow, and Force Allow beats Deny.

Mode comes last on purpose. A Deny on \`docs\` does not override an Allow on \`docs/public\`, because the deeper rule had already won. Force Allow is how you cut a hole in an otherwise closed branch.

## Permissions worth knowing

| Permission              | What it grants                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------- |
| \`read:pages\`            | Viewing a page                                                                      |
| \`write:pages\`           | Creating and editing pages; it also lets you read the page source                   |
| \`manage:pages\`          | Moving pages; it does not imply \`write:pages\`                                       |
| \`delete:pages\`          | Deleting pages                                                                      |
| \`publish:pages\`         | Changing a page's publish state, on its own and without \`write:pages\`               |
| \`review:pages\`          | Reviewing suggested edits, see [Approvals](/welcome/approvals)                      |
| \`manage:classification\` | Lowering a page's classification, see [A classified page](/welcome/classified-page) |

Permissions that are not tied to a path, such as \`manage:system\`, are granted to the group as a whole. \`manage:system\` bypasses every rule.

## Try it

1. Create a group and open its **Rules** section.
2. Add a rule that allows \`read:pages\` with Path Starts With \`welcome/\`.
3. Add a second rule that allows \`write:pages\` on Path Is Exactly \`welcome/start-here\`.
4. Add a member to the group and sign in as them to see what they can and cannot do.
`
  },
  {
    path: `${PREFIX}approvals`,
    title: 'Approvals',
    tags: ['welcome', 'approvals'],
    content: `Approvals let people who cannot edit a page suggest a change anyway, and let a reviewer decide whether it lands. It is how a wiki can stay open to readers, and even to the public, without letting anyone rewrite it.

## How it works

1. An administrator writes an **approval rule** that says which pages take suggestions, which groups may submit them and which groups review them.
2. A person in a submitter group edits a covered page. Instead of saving, their change is held as a suggestion.
3. Members of the reviewer groups are notified and can approve or reject it.
4. Once enough reviewers have approved, the change is written to the page, attributed to the reviewer who put it there.

See [Diagrams](/welcome/diagram-block) for this flow drawn out.

## Writing a rule

Rules live per site under **Admin**, then the site, then **Approvals**. Each rule has:

- **Applies To**: path starts with, path ends with, path is exactly, path matches regex, or the page has any or all of some tags.
- **Can submit edits**: the groups whose members may suggest changes. Naming the Guests group opens suggestions to anonymous readers.
- **Reviews submissions**: the groups that review, and who are notified of new suggestions.
- **Required approvals**: how many different reviewers must approve before the change is written. Until the last one, an approval only records a vote.

## Good to know

- A page that no enabled rule covers takes no suggestions at all.
- Approval rules are not ordered and do not override each other. When several cover a page, the page takes suggestions if any enabled rule allows it.
- A page can opt out with its own **Allow Contributions** switch, whatever the rules say.
- A person holding \`review:pages\`, or \`manage:system\`, can review without being named in any rule.
- If a page changes after a suggestion was made, approving that suggestion is refused as stale, so a reviewer never overwrites newer work by accident.
- Guests can submit suggestions, but reviewing needs a signed-in account.

## Try it

Create a rule that starts at \`welcome/\`, names the Guests group as submitters and a group you belong to as reviewers, then open this page in a private window and suggest an edit.
`
  },
  {
    path: `${PREFIX}classified-page`,
    title: 'A Classified Page',
    tags: ['welcome', 'classification'],
    content: `A classified page carries a sensitivity level. Every page has one: there is no unclassified state. Out of the box the levels are **Public**, **Internal** and **Restricted**, ordered from most open to most strict.

## How a level behaves

- A new page starts at its parent's level.
- A page can never be more open than its parent. This is the floor invariant, and it is checked against the order of the levels.
- Moving a page under a stricter parent raises it to that parent's level automatically.
- Raising a page's classification needs only the right to edit it. Lowering it also needs \`manage:classification\` on the page, on top of \`write:pages\`, so an ordinary editor cannot quietly declassify something sensitive.

Set a page's level in its page properties, under **Classification**. Changes are recorded in the audit log.

## Why it matters

Page rules can address a page by its classification with **Has Classification...**, the strongest match kind there is. Because classification follows the page, a rule written against it keeps working after the page is renamed or moved, and a Deny against a level cannot be beaten by an Allow against wherever the page happens to sit. See [Page rules](/welcome/page-rules).

Access tokens can be capped to a set of levels too, so an automation only ever sees what you intend. See [Connecting an AI agent](/welcome/mcp).

## Managing the levels

Administrators can add, rename and reorder levels under **Admin**, then **Classification**, which also lists the pages at each level. A level cannot be deleted while a page uses it, and the last remaining level cannot be deleted at all.

## Try it

Open the page properties of any page under \`welcome/\` and look at its Classification. Then try to set a child page to a more open level than its parent and see the floor invariant refuse it.
`
  },
  {
    path: `${PREFIX}glossary-term`,
    title: 'A Glossary Term',
    tags: ['welcome', 'glossary'],
    content: `The glossary lets you define a term once and have every mention of it across the site explain itself. A reader who hovers over a matching word sees its definition, and the word can link through to a page that covers it in depth.

## How matching works

- Matching is case-insensitive and whole-word, so a term like "log" does not fire inside "login".
- A term can have **aliases**, other names or abbreviations that resolve to the same definition.
- A term can point at a **canonical page**, and matched mentions then link to it.
- A mention inside a link you wrote yourself still gets its tooltip, but no second link is added.

## Adding a term

Under **Admin**, then the site, then **Glossary**, choose **New Term** and fill in:

- **Term**, such as \`Floor invariant\`
- **Definition**, shown as the hover tooltip, such as "A page can never be more open than its parent."
- **Aliases**, optionally
- **Canonical Page**, such as \`welcome/classified-page\`

Edits are staged until you choose **Save Glossary**. Managing the glossary needs the \`manage:glossary\` permission.

## Getting it onto existing pages

A page picks up glossary changes the next time it is rendered. To apply a change everywhere at once, use **Rerender All Pages** on the same screen.

## Try it

This sample content does not create a glossary entry for you. Add the example term above, rerender the pages and then look for "floor invariant" on [A classified page](/welcome/classified-page).
`
  },
  {
    path: `${PREFIX}diagram-block`,
    title: 'Diagrams',
    tags: ['welcome', 'diagrams'],
    content: `Blocks are components you drop into a page. The **Mermaid** block draws a diagram from plain text, so a flowchart lives in the page as text you can edit, diff and review like anything else.

::block-diagram{caption="How an edit suggestion is reviewed"}
\`\`\`mermaid
flowchart LR
  A[Reader suggests an edit] --> B{Does an approval rule cover the page?}
  B -->|No| C[Suggestion refused]
  B -->|Yes| D[Reviewers are notified]
  D --> E{Enough approvals?}
  E -->|Not yet| D
  E -->|Yes| F[Edit is written to the page]
\`\`\`
::

## Adding one

In the Markdown editor, open the block picker and choose **Mermaid**. It inserts the block with a starter flowchart that you replace with your own. The diagram source sits inside a fenced \`mermaid\` block so that Markdown leaves it alone.

The block takes three optional settings:

- **Caption**, shown under the diagram
- **Theme**, where \`auto\` follows the light or dark theme the reader is using
- **Alignment**, left or center

Mermaid also draws sequence diagrams, class diagrams, state diagrams, entity-relationship diagrams, Gantt charts and more.

## If it does not draw

A block only appears when it is switched on for the site. Administrators manage that under **Admin**, then the site, then **Blocks**.

## Elsewhere

An agent connected over MCP can render a diagram to a static SVG or PNG with the \`render_diagram\` tool. See [Connecting an AI agent](/welcome/mcp).
`
  },
  {
    path: `${PREFIX}mcp`,
    title: 'Connecting an AI Agent',
    tags: ['welcome', 'mcp'],
    content: `Cardinal.js has a built-in [Model Context Protocol](https://modelcontextprotocol.io) server. Any MCP client, such as an IDE agent, a desktop assistant or your own script, can search, read and, with the right token, write pages here. It runs inside the same process as the wiki, with nothing extra to deploy.

## Connect in three steps

1. **Mint a token.** Open your profile, then **API Access**, and create a personal access token. Narrow it before you copy it: restrict its scope, pin it to one site, cap its classification levels and choose an expiry. The secret is shown once.
2. **Point the client** at \`https://<your-instance>/_mcp\` and send the token as \`Authorization: Bearer <token>\`.
3. **Call a tool.** Start with \`list_sites\` to learn the site id, then try \`search_pages\`.

A client that spawns a local process can use the stdio transport instead, passing the token in the \`WIKI_MCP_API_KEY\` environment variable.

## What the tools do

| Tool                            | Use it to                                            |
| ------------------------------- | ---------------------------------------------------- |
| \`list_sites\`                    | See which sites the token can reach                  |
| \`search_pages\`                  | Full-text search, limited to what the token may read |
| \`get_page\`                      | Read a page by path, optionally with its source      |
| \`list_navigation\`               | Browse one folder of the page tree                   |
| \`create_page\` and \`update_page\` | Write pages, with a personal access token only       |
| \`render_diagram\`                | Render Mermaid or PlantUML to SVG or PNG             |
| \`watch_page\` and \`unwatch_page\` | Follow a page for changes                            |

There are more for assets, watchers and offline setup. Every tool is always listed, and refuses at call time with a reason if the token cannot use it.

## Permissions still apply

A tool call is authorized exactly like the person behind the token would be, through their groups and [page rules](/welcome/page-rules). A token with \`read:pages\` on \`welcome/\` sees only that, and one without \`write:pages\` cannot create or update anything. Classification caps narrow it further, see [A classified page](/welcome/classified-page).

## Try it

Mint a read-only token pinned to this site, connect a client and ask it to summarize the pages in this space.
`
  }
]
