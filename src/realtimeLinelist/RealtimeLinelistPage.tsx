/*
 * Vitalworks Pro — realtime line listing.
 *
 * Reads /api/tracker/trackedEntities (or /api/tracker/events) directly.
 * No analytics dependency: rows appear the moment a TEI/event is
 * persisted, so an implementer who just loaded a batch of test records
 * can immediately verify they landed without waiting for the analytics
 * tables to refresh.
 *
 * Layout:
 *   - Capture scope-selector TopBar (program / org-unit / category) so
 *     the user can re-pick context without leaving the page
 *   - ProtectedDataNotice banner when keyProtectedFieldsEnabled = true
 *   - Stats tiles, search input, refresh controls
 *   - Server-filtered table; sensitive (isProtected) attributes are
 *     masked for users without F_VIEW_PROTECTED_DATA / ALL.
 *
 * Mounted at hash route #/linelist?programId=…&orgUnitId=… and reachable
 * via the "Live records" button on the MainPage TopBar.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDataEngine, useDataQuery } from '@dhis2/app-runtime';
import { useHistory } from 'react-router-dom';
import { useLocationQuery } from 'capture-core/utils/routing';
import { TopBar } from 'capture-core/components/Pages/MainPage/TopBar';

const POLL_MS = 10_000;
const PAGE_SIZE = 50;
const F_VIEW_PROTECTED_DATA = 'F_VIEW_PROTECTED_DATA';

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
type AttrMeta = {
    id: string;
    displayName: string;
    isProtected: boolean;
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

const useDebounced = <T,>(value: T, ms = 350) => {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const id = window.setTimeout(() => setDebounced(value), ms);
        return () => window.clearTimeout(id);
    }, [value, ms]);
    return debounced;
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
    controlsRow: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        marginBottom: 12,
        flexWrap: 'wrap' as const,
    } as React.CSSProperties,
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
    search: {
        flex: 1,
        minWidth: 220,
        padding: '6px 10px',
        fontSize: 13,
        border: '1px solid #D1D5DB',
        borderRadius: 4,
        background: '#fff',
        color: '#1F2937',
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
    masked: {
        display: 'inline-block',
        padding: '2px 6px',
        borderRadius: 3,
        background: '#F3F4F6',
        color: '#6B7280',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        letterSpacing: '0.1em',
    } as React.CSSProperties,
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

const ME_QUERY = {
    me: { resource: 'me', params: { fields: 'authorities' } },
} as const;

const SETTINGS_QUERY: any = {
    settings: {
        resource: 'systemSettings',
        params: {
            key: ['keyProtectedFieldsEnabled'],
        },
    },
};

export const RealtimeLinelistPage = () => {
    const engine = useDataEngine();
    const history = useHistory();
    const { programId = '', orgUnitId = '' } = useLocationQuery() || {};
    const isReady = Boolean(programId && orgUnitId);

    const [payload, setPayload] = useState<FetchedPayload | null>(null);
    const [programMeta, setProgramMeta] = useState<any | null>(null);
    const [attrMeta, setAttrMeta] = useState<AttrMeta[]>([]);
    const [primaryAttrId, setPrimaryAttrId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const debouncedSearch = useDebounced(search, 350);

    const meQuery = useDataQuery(ME_QUERY);
    const settingsQuery = useDataQuery(SETTINGS_QUERY);

    const protectedFieldsEnabled = useMemo(() => {
        const v = (settingsQuery.data as any)?.settings?.keyProtectedFieldsEnabled;
        return v === true || v === 'true';
    }, [settingsQuery.data]);

    const canRevealProtected = useMemo(() => {
        const auths: string[] = ((meQuery.data as any)?.me?.authorities as string[]) || [];
        return auths.includes('ALL') || auths.includes(F_VIEW_PROTECTED_DATA);
    }, [meQuery.data]);

    const protectedAttrIds = useMemo(() => {
        if (!protectedFieldsEnabled) return new Set<string>();
        return new Set(attrMeta.filter((a) => a.isProtected).map((a) => a.id));
    }, [attrMeta, protectedFieldsEnabled]);

    const loadProgram = useCallback(async () => {
        if (!programId) {
            setProgramMeta(null);
            setAttrMeta([]);
            setPrimaryAttrId(null);
            return;
        }
        try {
            const data: any = await engine.query({
                program: {
                    resource: 'programs',
                    id: programId,
                    params: {
                        fields:
                            'id,displayName,programType,trackedEntityType[id,displayName],programTrackedEntityAttributes[searchable,displayInList,trackedEntityAttribute[id,displayName,isProtected]]',
                    },
                },
            });
            const prog = data?.program;
            setProgramMeta(prog);
            const attrs: AttrMeta[] = (prog?.programTrackedEntityAttributes || [])
                .map((p: any) => p?.trackedEntityAttribute)
                .filter(Boolean)
                .map((a: any) => ({
                    id: a.id,
                    displayName: a.displayName,
                    isProtected: !!a.isProtected,
                }));
            setAttrMeta(attrs);
            // Primary searchable attribute = first searchable (or first
            // displayInList, or just the first attribute).
            const ordered = (prog?.programTrackedEntityAttributes || []) as Array<any>;
            const primary =
                ordered.find((p) => p?.searchable)?.trackedEntityAttribute?.id ||
                ordered.find((p) => p?.displayInList)?.trackedEntityAttribute?.id ||
                ordered[0]?.trackedEntityAttribute?.id ||
                null;
            setPrimaryAttrId(primary);
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
            const params: Record<string, any> = {
                program: programId,
                orgUnit: orgUnitId,
                ouMode: 'DESCENDANTS',
                pageSize: PAGE_SIZE,
                order: 'createdAt:desc',
                fields,
            };
            // Server-side filter on the primary attribute (tracker only).
            // Skip when a sensitive attr is primary and the user lacks
            // F_VIEW_PROTECTED_DATA — searching a masked field would
            // leak the value via the URL.
            const term = debouncedSearch.trim();
            if (isTracker && term && primaryAttrId) {
                const protectedHit = protectedAttrIds.has(primaryAttrId);
                if (!protectedHit || canRevealProtected) {
                    params.filter = `${primaryAttrId}:LIKE:${term}`;
                }
            }
            const data: any = await engine.query({
                result: { resource, params },
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
    }, [engine, programMeta, isReady, programId, orgUnitId, debouncedSearch, primaryAttrId, protectedAttrIds, canRevealProtected]);

    useEffect(() => {
        loadProgram();
    }, [loadProgram]);

    useEffect(() => {
        if (!isReady || !programMeta) return;
        refresh();
        const id = window.setInterval(refresh, POLL_MS);
        return () => window.clearInterval(id);
    }, [isReady, programMeta, refresh]);

    const renderAttrValue = (attribute: string, value?: string) => {
        if (!value) return <span style={C.muted}>—</span>;
        if (protectedAttrIds.has(attribute) && !canRevealProtected) {
            return <span style={C.masked} title="Protected — value masked">••••••</span>;
        }
        return value;
    };

    const renderTei = (tei: TEI) => {
        const primaryAttrVal = primaryAttrId
            ? tei.attributes?.find((a) => a.attribute === primaryAttrId)
            : tei.attributes?.[0];
        const primaryId = primaryAttrId || primaryAttrVal?.attribute || '';
        const e = tei.enrollments?.[0];
        return (
            <tr key={tei.trackedEntity}>
                <td style={C.td}>
                    <span style={C.mono}>{tei.trackedEntity}</span>
                </td>
                <td style={C.td}>{renderAttrValue(primaryId, primaryAttrVal?.value)}</td>
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

    const primaryAttrLabel = useMemo(() => {
        if (!primaryAttrId) return 'attribute';
        return (
            attrMeta.find((a) => a.id === primaryAttrId)?.displayName || 'attribute'
        );
    }, [primaryAttrId, attrMeta]);
    const searchDisabled = !isReady || (!primaryAttrId);
    const searchProtectedBlocked =
        !!primaryAttrId &&
        protectedAttrIds.has(primaryAttrId) &&
        !canRevealProtected;

    return (
        <>
            <TopBar programId={programId} orgUnitId={orgUnitId} selectedCategories={undefined} />
            <div style={C.page}>
                {protectedFieldsEnabled && (
                    <div
                        data-test="linelist-protected-data-notice"
                        style={{
                            padding: '10px 14px',
                            background: '#FFFBEB',
                            border: '1px solid #FCD34D',
                            color: '#92400E',
                            borderRadius: 6,
                            marginBottom: 12,
                            fontSize: 13,
                        }}
                    >
                        <strong>Protected data settings active.</strong>{' '}
                        Sensitive attributes are masked
                        {canRevealProtected
                            ? ' until you open the record.'
                            : ' — you don\'t have F_VIEW_PROTECTED_DATA, so values won\'t be revealed here.'}
                    </div>
                )}

                <div style={C.headerRow}>
                    <div>
                        <h2 style={C.title}>Live records</h2>
                        <div style={C.subtitle}>
                            Realtime line listing — reads tracker tables directly, refreshes every{' '}
                            {POLL_MS / 1000}s.
                        </div>
                    </div>
                </div>

                <div style={C.controlsRow}>
                    <input
                        type="search"
                        style={C.search}
                        placeholder={
                            searchProtectedBlocked
                                ? `Search disabled — ${primaryAttrLabel} is a protected field`
                                : `Search by ${primaryAttrLabel}…`
                        }
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        disabled={searchDisabled || searchProtectedBlocked}
                        aria-label="Search records"
                    />
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
                        Advanced search
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

                {!isReady && (
                    <div style={C.notice}>
                        Pick a program and org unit in the bar above (or append{' '}
                        <code>?programId=…&orgUnitId=…</code> to the URL).
                    </div>
                )}

                {error && <div style={C.error}>Could not load records: {error}</div>}

                <div style={C.statsRow}>
                    <div style={C.tile}>
                        Program
                        <div style={C.tileValue}>
                            {programMeta?.displayName || programId || '—'}
                        </div>
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
                        <div style={C.empty}>
                            {debouncedSearch
                                ? 'No records match the current search.'
                                : 'No records match this program / org unit yet.'}
                        </div>
                    ) : payload && payload.kind === 'tracker' ? (
                        <table style={C.table}>
                            <thead>
                                <tr>
                                    <th style={C.th}>Tracked Entity</th>
                                    <th style={C.th}>{primaryAttrLabel}</th>
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
        </>
    );
};
