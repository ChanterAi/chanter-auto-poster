'use strict';

// Parent-campaign grouping for the server-rendered Release Queue
// (src/views/index.ejs, "All Channels" mode). Deliberately separate from
// src/pages/dashboard-accounting.mjs, whose summarizeDashboardCampaigns()
// return shape is asserted with deepEqual in test/dashboard-accounting.test.js
// and must not gain new fields. This module only ever reads plain "post"
// objects already shaped by postsMapper.js — it never touches Firestore.

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function toMillis(isoOrNull) {
  if (!isoOrNull) return null;
  const millis = Date.parse(isoOrNull);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Group posts by campaignId. Posts with no campaignId are omitted — the
 * Release Queue renders those as standalone cards, same as today.
 */
function groupPostsByCampaign(posts) {
  const groups = new Map();
  (Array.isArray(posts) ? posts : []).forEach((post) => {
    const campaignId = text(post && post.campaignId);
    if (!campaignId) return;
    const list = groups.get(campaignId) || [];
    list.push(post);
    groups.set(campaignId, list);
  });
  return groups;
}

function aggregateState(statusCounts) {
  const statuses = Object.keys(statusCounts);
  if (statuses.length === 0) return 'unknown';
  if (statuses.length === 1) return statuses[0];
  if (statusCounts.failed > 0) return 'attention';
  return 'mixed';
}

/**
 * One summary per campaignId: channel count, job count, scheduled range,
 * and an aggregate state — never invents evidence, only rolls up what each
 * child job already reports. A failure on one child never changes another
 * child's own recorded status; this is purely a display rollup.
 */
function summarizeCampaigns(posts) {
  const groups = groupPostsByCampaign(posts);
  const summaries = [];

  groups.forEach((jobs, campaignId) => {
    const sorted = [...jobs].sort((a, b) => {
      const orderDiff = Number(a.channelOrder || 0) - Number(b.channelOrder || 0);
      if (orderDiff !== 0) return orderDiff;
      return (toMillis(a.scheduledAt) || 0) - (toMillis(b.scheduledAt) || 0);
    });

    const accountIds = [...new Set(sorted.map((job) => text(job.accountId)).filter(Boolean))];
    const statusCounts = {};
    sorted.forEach((job) => {
      const status = text(job.status).toLowerCase() || 'pending';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    const scheduledMillis = sorted.map((job) => toMillis(job.scheduledAt)).filter((value) => value !== null);
    const scheduledRange = scheduledMillis.length > 0
      ? { start: new Date(Math.min(...scheduledMillis)).toISOString(), end: new Date(Math.max(...scheduledMillis)).toISOString() }
      : { start: null, end: null };

    summaries.push({
      campaignId,
      jobCount: sorted.length,
      channelCount: accountIds.length,
      accountIds,
      statusCounts,
      aggregateState: aggregateState(statusCounts),
      scheduledRange,
      jobs: sorted
    });
  });

  return summaries;
}

/**
 * Channel count of the most recently created campaign, or 1 when there is
 * no campaign data at all. Used to pick the Release Queue's default view:
 * a multi-channel campaign defaults to "All Channels"; anything else
 * defaults to "Active Channel" (today's existing behavior).
 */
function latestCampaignChannelCount(posts) {
  const groups = groupPostsByCampaign(posts);
  if (groups.size === 0) return 1;

  let latest = null;
  groups.forEach((jobs, campaignId) => {
    const createdAt = jobs.reduce((max, job) => Math.max(max, toMillis(job.createdAt) || 0), 0);
    if (!latest || createdAt > latest.createdAt) {
      latest = { campaignId, createdAt, jobs };
    }
  });

  const accountIds = new Set(latest.jobs.map((job) => text(job.accountId)).filter(Boolean));
  return Math.max(1, accountIds.size);
}

module.exports = { groupPostsByCampaign, summarizeCampaigns, latestCampaignChannelCount };
