import type { EndpointUri } from "../../protocol/src/index.ts";

export type MentionAliasTarget = EndpointUri | EndpointUri[];
export type MentionAliases = Record<string, MentionAliasTarget>;

export function inferMentions(text: string, explicit: EndpointUri[] | undefined, aliases: MentionAliases): EndpointUri[] {
  const mentions = new Set<EndpointUri>(explicit ?? []);
  const aliasPattern = /(^|\s)@([a-zA-Z0-9_.-]+)/g;
  let match = aliasPattern.exec(text);

  while (match) {
    const alias = match[2];
    const target = aliases[alias];
    for (const uri of aliasTargets(target)) {
      mentions.add(uri);
    }
    match = aliasPattern.exec(text);
  }

  return [...mentions];
}

function aliasTargets(target: MentionAliasTarget | undefined): EndpointUri[] {
  if (!target) {
    return [];
  }
  return Array.isArray(target) ? target : [target];
}
