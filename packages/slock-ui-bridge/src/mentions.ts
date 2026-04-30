import type { EndpointUri } from "../../protocol/src/index.ts";

export type MentionAliases = Record<string, EndpointUri>;

export function inferMentions(text: string, explicit: EndpointUri[] | undefined, aliases: MentionAliases): EndpointUri[] {
  const mentions = new Set<EndpointUri>(explicit ?? []);
  const aliasPattern = /(^|\s)@([a-zA-Z0-9_.-]+)/g;
  let match = aliasPattern.exec(text);

  while (match) {
    const alias = match[2];
    const uri = aliases[alias];
    if (uri) {
      mentions.add(uri);
    }
    match = aliasPattern.exec(text);
  }

  return [...mentions];
}
