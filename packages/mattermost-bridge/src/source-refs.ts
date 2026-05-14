import type { SourceRef } from "../../collaboration-context/src/index.ts";
import type { MattermostSourceMetadata } from "./types.ts";

export function mattermostPostUri(teamId: string, channelId: string, postId: string): string {
  return `${mattermostChannelUri(teamId, channelId)}/post/${encodePart(required(postId, "post_id"))}`;
}

export function mattermostChannelUri(teamId: string, channelId: string): string {
  return `mattermost://team/${encodePart(required(teamId, "team_id"))}/channel/${encodePart(required(channelId, "channel_id"))}`;
}

export function mattermostActionUri(source: MattermostSourceMetadata & { user_id: string; action: string }): string {
  const base = clean(source.post_id)
    ? mattermostPostUri(source.team_id, source.channel_id, source.post_id)
    : mattermostChannelUri(source.team_id, source.channel_id);
  return `${base}/user/${encodePart(required(source.user_id, "user_id"))}/action/${encodePart(required(source.action, "action"))}`;
}

export function sourceRefFromMattermost(source: MattermostSourceMetadata, label = "Mattermost"): Extract<SourceRef, { kind: "external" }> {
  return buildMattermostSourceRef(source, label);
}

export function buildMattermostSourceRef(source: MattermostSourceMetadata, label = "Mattermost"): Extract<SourceRef, { kind: "external" }> {
  return {
    kind: "external",
    uri: sourceUri(source),
    label,
  };
}

function sourceUri(source: MattermostSourceMetadata): string {
  const teamId = required(source.team_id, "team_id");
  const channelId = required(source.channel_id, "channel_id");
  const postId = clean(source.post_id);
  const userId = clean(source.user_id);
  const action = clean(source.action);

  if (userId && action) {
    return mattermostActionUri({ team_id: teamId, channel_id: channelId, post_id: postId, user_id: userId, action });
  }

  if (postId) {
    return mattermostPostUri(teamId, channelId, postId);
  }

  return mattermostChannelUri(teamId, channelId);
}

function required(value: string | undefined, name: string): string {
  const trimmed = clean(value);
  if (!trimmed) {
    throw new Error(`Mattermost source ref requires ${name}`);
  }
  return trimmed;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}
