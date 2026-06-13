/*
 * Vitalworks Pro — realtime line listing.
 *
 * Reads directly from the tracker operational tables via
 * /api/tracker/trackedEntities and /api/tracker/events. No analytics
 * dependency: rows appear the moment a TEI/event is persisted, so an
 * implementer who just loaded a batch of test records can immediately
 * verify they landed without waiting for the analytics tables to refresh.
 *
 * Mounted at hash route #/linelist?programId=…&orgUnitId=… and reachable
 * via the "Live records" button on the MainPage TopBar.
 *
 * Plain-HTML implementation (no @dhis2/ui imports) because pulling in
 * the design-system table component dragged a second copy of
 * @tanstack/react-query into the bundle and broke QueryClient context.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useDataEngine } from '@dhis2/app-runtime';
import { useLocation, useHistory } from 'react-router-dom';

const POLL_MS = 10_000;
const PAGE_SIZE = 50;

type Attribute = { attribute: string; displayName?: string; value: string };
type Enrollment = { enrollment: string; status: string; enrolledAt: string; occurredAt?: string };
type TEI = {
    trackedEntity: string;
    trackedEntityType?: string;
    createdAt?: string;
    updatedAt?: string;
    orgUnit?: string;
    attributes?: Attribute[];
    enrollments?: Enrollment[];
};
type Event = {
    event: string;
    program?: string;
    programStage?: string;
    orgUnit?: string;
    status?: string;
    occurredAt?: string;
    createdAt?: string;
    updatedAt?: string;
    dataValues?: Array<{ dataElement: string; value: string }>;
};
type FetchedPayload = {
    kind: 'tracker' | 'event';
    rows: Array<TEI | Event>;
    total?: number;
    fetchedAt: Date;
};

const parseQuery = (search: string) => {
    const out: Record<string, string> = {};
    const s = search.startsWith('?') ? search.slice(1) : search;
    for (const pair of s.split('&')) {
        if (!pair) continue;
        const [k, v = ''] = pair.split('=');
        out[decodeURIComponent(k)] = decodeURIComponent(v);
    }
    return out;
};

const fmtDate = (iso?: string) => {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return iso;
    }
};

const C = {
    page: { padding: 16, maxWidth: 1400, margin: '0 auto', fontFamily: 'inherit' } as React.CSSProperties,
    headerRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
        flexWrap: 'wrap' as const,
        gap: 8,
    } as React.CSSProperties,
    title: { fontSize: 20, fontWeight: 600, color: '#1F2937', margin: 0 } as React.CSSProperties,
    subtitle: { fontSize: 13, color: '#6B7280', marginTop: 2 } as React.CSSProperties,
    statsRow: { display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' as const } as React.CSSProperties,
    tile: {
        background: '#F3F4F6',
        border: '1px solid #E5E7EB',
        borderRadius: 6,
        padding: '8px 12px',
        fontSize: 12,
        color: '#374151',
        minWidth: 120,
    } as React.CSSProperties,
    tileValue: { fontWeight: 600, fontSize: 15, color: '#111827', marginTop: 2 } as React.CSSProperties,
    btnRow: { display: 'flex', gap: 8, alignItems: 'center' } as React.CSSProperties,
    btn: {
        background: '#fff',
        color: '#1F4E79',
        border: '1px solid #D1D5DB',
        borderRadius: 4,
        padding: '6px 12px',
        fontSize: 13,
        cursor: 'pointer',
        fontWeight: 500,
    } as React.CSSProperties,
    btnPrimary: {
        background: '#1F4E79',
        color: '#fff',
        border: '1px solid #1F4E79',
        borderRadius: 4,
        padding: '6px 12px',
        fontSize: 13,
        cursor: 'pointer',
        fontWeight: 500,
    } as React.CSSProperties,
    notice: {
        padding: '12px 14px',
        background: '#FFFBEB',
        border: '1px solid #FCD34D',
        color: '#92400E',
        borderRadius: 4,
        marginBottom: 12,
        fontSize: 13,
    } as React.CSSProperties,
    error: {
        padding: '12px 14px',
        background: '#FEF2F2',
        border: '1px solid #FCA5A5',
        color: '#991B1B',
        borderRadius: 4,
        marginBottom: 12,
        fontSize: 13,
    } as React.CSSProperties,
    tableWrap: {
        background: '#fff',
        border: '1px solid #E5E7EB',
        borderRadius: 6,
        overflow: 'auto',
    } as React.CSSProperties,
    table: { width: '100%', borderCollapse: 'collapse' as const } as React.CSSProperties,
    th: {
        padding: '10px 12px',
        textAlign: 'left' as const,
        fontSize: 12,
        fontWeight: 600,
        background: '#F9FAFB',
        borderBottom: '1px solid #E5E7EB',
        color: '#4B5563',
        textTransform: 'uppercase' as const,
        letterSpacing: '0.04em',
    } as React.CSSProperties,
    td: {
        padding: '10px 12px',
        borderBottom: '1px solid #F3F4F6',
        fontSize: 13,
        color: '#1F2937',
    } as React.CSSProperties,
    mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 } as React.CSSProperties,
    muted: { color: '#6B7280', fontSize: 12 } as React.CSSProperties,
    pill: {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
    } as React.CSSProperties,
    empty: { padding: 24, textAlign: 'center' as const, color: '#6B7280' } as React.CSSProperties,
};

const pillFor = (status?: string) => {
    if (!status) return { ...C.pill, background: '#E5E7EB', color: '#374151' };
    if (status === 'ACTIVE') return { ...C.pill, background: '#DCFCE7', color: '#166534' };
    if (status === 'COMPLETED') return { ...C.pill, background: '#DBEAFE', color: '#1E40AF' };
    if (status === 'CANCELLED') return { ...C.pill, background: '#FEE2E2', color: '#991B1B' };
    return { ...C.pill, background: '#F3F4F6', color: '#374151' };
};

export const RealtimeLinelistPage = () => {
    const engine = useDataEngine();
    const location = useLocation();
    const history = useHistory();
    const { programId = '', orgUnitId = '' } = parseQuery(location.search);

    const [payload, setPayload] = useState<FetchedPayload | null>(null);
    const [programMeta, setProgramMeta] = useState<any | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isReady = Boolean(programId && orgUnitId);

    const loadProgram = useCallback(async () => {
        if (!programId) {
            setProgramMeta(null);
            return;
        }
        try {
            const data: any = await engine.query({
                program: {
                    resource: 'programs',
                    id: programId,
                    params: {
                        fields: 'id,displayName,programType,trackedEntityType[id,displayName]',
                    },
                },
            });
            setProgramMeta(data?.program);
        } catch {
            setProgramMeta(null);
        }
    }, [engine, programId]);

    const refresh = useCallback(async () => {
        if (!isReady || !programMeta) return;
        setLoading(true);
        setError(null);
        try {
            const isTracker = programMeta?.programType === 'WITH_REGISTRATION';
            const resource = isTracker ? 'tracker/trackedEntities' : 'tracker/events';
            const fields = isTracker
                ? 'trackedEntity,trackedEntityType,createdAt,updatedAt,orgUnit,attributes[attribute,displayName,value],enrollments[enrollment,status,enrolledAt,occurredAt]'
                : 'event,program,programStage,orgUnit,status,occurredAt,createdAt,updatedAt,dataValues[dataElement,value]';
            const data: any = await engine.query({
                result: {
                    resource,
                    params: {
                        program: programId,
                        orgUnit: orgUnitId,
                        ouMode: 'DESCENDANTS',
                        pageSize: PAGE_SIZE,
                        order: 'createdAt:desc',
                        fields,
                    },
                },
            });
            const r = data?.result || {};
            const rows = r.instances || r.trackedEntities || r.events || [];
            setPayload({
                kind: isTracker ? 'tracker' : 'event',
                rows,
                total: r.total,
                fetchedAt: new Date(),
            });
        } catch (e: any) {
            setError(e?.message || 'Failed to fetch records');
        } finally {
            setLoading(false);
        }
    }, [engine, programMeta, isReady, programId, orgUnitId]);

    useEffect(() => {
        loadProgram();
    }, [loadProgram]);

    useEffect(() => {
        if (!isReady || !programMeta) return;
        refresh();
        const id = window.setInterval(refresh, POLL_MS);
        return () => window.clearInterval(id);
    }, [isReady, programMeta, refresh]);

    const renderTei = (tei: TEI) => {
        const primary = tei.attributes?.[0];
        const e = tei.enrollments?.[0];
        return (
            <tr key={tei.trackedEntity}>
                <td style={C.td}>
                    <span style={C.mono}>{tei.trackedEntity}</span>
                </td>
                <td style={C.td}>{primary?.value || <span style={C.muted}>—</span>}</td>
                <td style={C.td}>
                    {e ? <span style={pillFor(e.status)}>{e.status}</span> : <span style={C.muted}>—</span>}
                </td>
                <td style={C.td}>{fmtDate(e?.enrolledAt)}</td>
                <td style={C.td}>{fmtDate(tei.createdAt)}</td>
                <td style={C.td}>{fmtDate(tei.updatedAt)}</td>
                <td style={C.td}>
                    {e ? (
                        <button
                            type="button"
                            style={C.btn}
                            onClick={() => history.push(`/enrollment?enrollmentId=${e.enrollment}`)}
                        >
                            Open
                        </button>
                    ) : null}
                </td>
            </tr>
        );
    };

    const renderEvent = (ev: Event) => (
        <tr key={ev.event}>
            <td style={C.td}>
                <span style={C.mono}>{ev.event}</span>
            </td>
            <td style={C.td}>
                <span style={pillFor(ev.status)}>{ev.status || '—'}</span>
            </td>
            <td style={C.td}>{fmtDate(ev.occurredAt)}</td>
            <td style={C.td}>{fmtDate(ev.createdAt)}</td>
            <td style={C.td}>{fmtDate(ev.updatedAt)}</td>
            <td style={C.td}>{ev.dataValues?.length ?? 0}</td>
            <td style={C.td}>
                <button
                    type="button"
                    style={C.btn}
                    onClick={() => history.push(`/viewEvent?viewEventId=${ev.event}`)}
                >
                    Open
                </button>
            </td>
        </tr>
    );

    return (
        <div style={C.page}>
            <div style={C.headerRow}>
                <div>
                    <h2 style={C.title}>Live records</h2>
                    <div style={C.subtitle}>
                        Realtime line listing — reads tracker tables directly, refreshes every {POLL_MS / 1000}s.
                    </div>
                </div>
                <div style={C.btnRow}>
                    <button
                        type="button"
                        style={C.btn}
                        onClick={() => history.push(`/?programId=${programId}&orgUnitId=${orgUnitId}`)}
                    >
                        Working list
                    </button>
                    <button
                        type="button"
                        style={C.btn}
                        onClick={() => history.push(`/search?programId=${programId}`)}
                    >
                        Search
                    </button>
                    <button
                        type="button"
                        style={C.btnPrimary}
                        onClick={refresh}
                        disabled={loading || !isReady}
                    >
                        {loading ? 'Refreshing…' : 'Refresh now'}
                    </button>
                </div>
            </div>

            {!isReady && (
                <div style={C.notice}>
                    Pick a program and org unit first — append <code>?programId=…&orgUnitId=…</code> to the URL
                    or open this page via the "Live records" link on the working list.
                </div>
            )}

            {error && <div style={C.error}>Could not load records: {error}</div>}

            <div style={C.statsRow}>
                <div style={C.tile}>
                    Program
                    <div style={C.tileValue}>{programMeta?.displayName || programId || '—'}</div>
                </div>
                <div style={C.tile}>
                    Type
                    <div style={C.tileValue}>{programMeta?.programType || '—'}</div>
                </div>
                <div style={C.tile}>
                    Org unit
                    <div style={C.tileValue} title={orgUnitId}>
                        {orgUnitId || '—'}
                    </div>
                </div>
                <div style={C.tile}>
                    Records (this page)
                    <div style={C.tileValue}>{payload?.rows.length ?? '—'}</div>
                </div>
                <div style={C.tile}>
                    Total
                    <div style={C.tileValue}>{payload?.total ?? '—'}</div>
                </div>
                <div style={C.tile}>
                    Last refreshed
                    <div style={C.tileValue}>
                        {payload?.fetchedAt ? fmtDate(payload.fetchedAt.toISOString()) : '—'}
                    </div>
                </div>
            </div>

            <div style={C.tableWrap}>
                {!payload && loading ? (
                    <div style={C.empty}>Loading…</div>
                ) : payload && payload.rows.length === 0 ? (
                    <div style={C.empty}>No records match this program / org unit yet.</div>
                ) : payload && payload.kind === 'tracker' ? (
                    <table style={C.table}>
                        <thead>
                            <tr>
                                <th style={C.th}>Tracked Entity</th>
                                <th style={C.th}>Primary attribute</th>
                                <th style={C.th}>Status</th>
                                <th style={C.th}>Enrolled at</th>
                                <th style={C.th}>Created</th>
                                <th style={C.th}>Last updated</th>
                                <th style={C.th}></th>
                            </tr>
                        </thead>
                        <tbody>{(payload.rows as TEI[]).map(renderTei)}</tbody>
                    </table>
                ) : payload && payload.kind === 'event' ? (
                    <table style={C.table}>
                        <thead>
                            <tr>
                                <th style={C.th}>Event</th>
                                <th style={C.th}>Status</th>
                                <th style={C.th}>Occurred at</th>
                                <th style={C.th}>Created</th>
                                <th style={C.th}>Last updated</th>
                                <th style={C.th}>Data values</th>
                                <th style={C.th}></th>
                            </tr>
                        </thead>
                        <tbody>{(payload.rows as Event[]).map(renderEvent)}</tbody>
                    </table>
                ) : null}
            </div>
        </div>
    );
};
