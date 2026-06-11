/* eslint-disable */
/**
 * Vitalworks Pro — provenance banner for ASSIGN_VALUE_FROM_EVENT_LOOKUP.
 *
 * Renders above the event form when the server-side AOP pre-import hook
 * auto-filled one or more data elements via a lookup rule action. The
 * banner is purely informational: it shows which DEs were filled, the
 * source event and date, and any conflict / no-value-found state.
 *
 * Reads from /api/tracker/rules/lookup/audit?event=<uid>. When no
 * audit rows exist (the common case for events that didn't trigger any
 * lookup rule), the component returns null and nothing is rendered.
 *
 * The host (WidgetEventEdit) only needs to pass `eventId`. The banner
 * makes its own GET, dedupes by target DE (showing only the most
 * recent assignment per DE), and tolerates the endpoint being absent
 * (older server build).
 */
import React from 'react';
import i18n from '@dhis2/d2-i18n';
import { useDataQuery } from '@dhis2/app-runtime';
import { NoticeBox } from '@dhis2/ui';

const auditQuery = {
    audit: {
        resource: 'tracker/rules/lookup/audit',
        params: ({ eventId }) => ({ event: eventId, limit: 20 }),
    },
};

function dedupeByTargetDe(entries) {
    const seen = new Set();
    const out = [];
    for (const e of entries || []) {
        const key = e.target_de_uid || e.targetDataElementUid;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(e);
    }
    return out;
}

function formatEntry(e) {
    const target = e.target_de_uid || e.targetDataElementUid || '?';
    const source = e.source_event_uid || e.sourceEventUid;
    const value = e.assigned_value || e.assignedValue;
    const occurredAt = e.occurred_at || e.occurredAt;
    const status = e.status;
    const when = occurredAt ? new Date(occurredAt).toISOString().slice(0, 10) : '';
    if (status === 'ASSIGNED' && value && source) {
        return i18n.t(
            'Field {{target}} auto-filled with {{value}} from event {{source}} ({{when}})',
            { target, value, source, when }
        );
    }
    if (status === 'CONFLICT_BLOCKED') {
        return i18n.t(
            'Field {{target}} not assigned: multiple candidate values disagree ({{when}})',
            { target, when }
        );
    }
    if (status === 'NO_SOURCE_VALUE_FOUND') {
        return i18n.t(
            'Field {{target}} lookup ran but found no source value ({{when}})',
            { target, when }
        );
    }
    return `${target}: ${status}${when ? ` (${when})` : ''}`;
}

function hasConflict(entries) {
    return (entries || []).some(
        e => e.status === 'CONFLICT_BLOCKED' || e.conflict_detected === true,
    );
}

export const EventLookupAuditBanner = ({ eventId }) => {
    const { loading, error, data } = useDataQuery(auditQuery, {
        variables: { eventId },
        lazy: !eventId,
    });

    if (!eventId || loading || error) return null;
    const entries = dedupeByTargetDe(data?.audit?.entries);
    if (!entries.length) return null;

    const warning = hasConflict(entries);
    return (
        <div style={{ marginBottom: 12 }}>
            <NoticeBox
                title={
                    warning
                        ? i18n.t('Lookup conflict on this event')
                        : i18n.t('Values auto-filled from other events')
                }
                {...(warning ? { warning: true } : { info: true })}
            >
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {entries.map(e => (
                        <li key={`${e.audit_uid || e.auditUid}-${e.target_de_uid || e.targetDataElementUid}`}>
                            {formatEntry(e)}
                        </li>
                    ))}
                </ul>
            </NoticeBox>
        </div>
    );
};

export default EventLookupAuditBanner;
