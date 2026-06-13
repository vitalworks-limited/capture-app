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
 *   - Capture scope-selector TopBar (program / org-unit / category)
 *   - Full-bleed VW Pro themed page with search, column manager,
 *     paginated table, and a right-side detail drawer showing the
 *     selected TEI's enrollments + events without leaving the list.
 *   - Sensitive (isProtected) attributes are masked (••••) for users
 *     without F_VIEW_PROTECTED_DATA / ALL; a small shield-lock icon
 *     replaces the previous verbose banner.
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
const DEFAULT_PAGE_SIZE = 50;
const F_VIEW_PROTECTED_DATA = 'F_VIEW_PROTECTED_DATA';

// VW Pro design tokens
const T = {
    brand: '#1F4E79',
    brandSoft: '#E6EEF6',
    surface: '#FFFFFF',
    bg: '#F7F8FA',
    bgAlt: '#F3F4F6',
    border: '#E5E7EB',
    borderStrong: '#D1D5DB',
    text: '#1F2937',
    textMuted: '#6B7280',
    textInverse: '#FFFFFF',
    success: '#166534',
    successSoft: '#DCFCE7',
    info: '#1E40AF',
    infoSoft: '#DBEAFE',
    danger: '#991B1B',
    dangerSoft: '#FEE2E2',
    warn: '#92400E',
    warnSoft: '#FEF3C7',
    radius: 8,
    radiusSm: 4,
    shadow: '0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(15,23,42,0.04)',
} as const;

type Attribute = { attribute: string; displayName?: string; value: string };
type Enrollment = {
    enrollment: string;
    program?: string;
    status: string;
    enrolledAt: string;
    occurredAt?: string;
    events?: TrackerEvent[];
};
type TrackerEvent = {
    event: string;
    programStage?: string;
    status?: string;
    occurredAt?: string;
    createdAt?: string;
    dataValues?: Array<{ dataElement: string; value: string }>;
};
type TEI = {
    trackedEntity: string;
    trackedEntityType?: string;
    createdAt?: string;
    updatedAt?: string;
    orgUnit?: string;
    attributes?: Attribute[];
    enrollments?: Enrollment[];
};
type EventRow = {
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
    rows: Array<TEI | EventRow>;
    total?: number;
    pageCount?: number;
    page: number;
    pageSize: number;
    fetchedAt: Date;
};
type AttrMeta = {
    id: string;
    displayName: string;
    isProtected: boolean;
    displayInList: boolean;
    searchable: boolean;
    /**
     * Lookup of option-set `code -> displayName` for this attribute,
     * if it's bound to an option set. When present, the line list
     * resolves stored codes (e.g. `OPH00257`) into human labels
     * (e.g. `Male`). Empty map means the attribute is free-text.
     */
    optionMap?: Record<string, string>;
    /**
     * True when the attribute carries PII / sensitive data and should
     * be masked in the line list by default. Falls back to the metadata
     * `isProtected` flag but the line list never reveals these values
     * inline — opening the record (drawer or full enrollment page) is
     * the supported reveal path.
     */
    sensitive: boolean;
};
type StageMeta = { id: string; displayName: string };

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

/**
 * Vitalworks Pro — should the line list treat this attribute as PII?
 *
 * The list view is the riskiest surface (many rows visible at once, easy
 * to screenshot, easy to share). We err strongly on the side of masking:
 *   - any attribute the metadata flags `isProtected` or `confidential`
 *   - obvious identifier value types (PHONE_NUMBER, EMAIL, PERSONAL_ID,
 *     IDENTIFIER, AGE, USERNAME)
 *   - any attribute whose display name hints at PII (name, phone, email,
 *     address, dob, id number, contact)
 * The drawer (one-record-at-a-time) reveals the real value once the
 * user explicitly picks a record.
 */
const PII_NAME_HINTS = [
    'name',
    'phone',
    'mobile',
    'email',
    'address',
    'dob',
    'date of birth',
    'national id',
    'identifier',
    'identity',
    'passport',
    'nic',
    'contact',
    'gps',
    'latitude',
    'longitude',
    // Per-patient assigned identifiers commonly used in HIV / clinical
    // tracker programs. Each of these uniquely keys back to one person
    // and therefore counts as PII for line-list purposes.
    'art number',
    'art no',
    'patient id',
    'patient no',
    'patient number',
    'patient barcode',
    'barcode',
    'hts client',
    'client code',
    'client number',
    'mrn',
    'medical record',
    'registration number',
    'enrollment number',
    'beneficiary',
];
const PII_VALUE_TYPES = new Set([
    'PHONE_NUMBER',
    'EMAIL',
    'PERSONAL_ID',
    'IDENTIFIER',
    'AGE',
    'USERNAME',
]);
const isSensitiveAttr = (a: any): boolean => {
    if (a?.isProtected || a?.confidential) return true;
    if (a?.valueType && PII_VALUE_TYPES.has(String(a.valueType))) return true;
    const name = String(a?.displayName || '').toLowerCase();
    return PII_NAME_HINTS.some((h) => name.includes(h));
};

const useDebounced = <T,>(value: T, ms = 350) => {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const id = window.setTimeout(() => setDebounced(value), ms);
        return () => window.clearTimeout(id);
    }, [value, ms]);
    return debounced;
};

const csvEscape = (s: any): string => {
    if (s == null) return '';
    const str = String(s);
    if (/["\n,]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
};

const tsvEscape = (s: any): string => {
    if (s == null) return '';
    return String(s).replace(/\t/g, ' ').replace(/\n/g, ' ');
};

const triggerDownload = (filename: string, mime: string, content: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/**
 * Vitalworks Pro — flatten one TEI into a record-per-row shape suitable
 * for CSV/TSV. Mirrors the live-list rendering: TE UID, each visible
 * column (with optionset code → displayName resolution), enrollment
 * status, timestamps. Sensitive columns export as the literal token
 * "[masked]" so the file matches the on-screen disclosure surface.
 */
const flattenTei = (
    tei: TEI,
    columns: AttrMeta[],
    sensitiveIds: Set<string>,
    optionMaps: Record<string, Record<string, string>>,
) => {
    const attrByUid: Record<string, string> = {};
    for (const a of tei.attributes || []) attrByUid[a.attribute] = a.value;
    const enr = tei.enrollments?.[0];
    const row: Record<string, any> = {
        trackedEntity: tei.trackedEntity,
        orgUnit: tei.orgUnit || '',
        createdAt: tei.createdAt || '',
        updatedAt: tei.updatedAt || '',
        enrollmentStatus: enr?.status || '',
        enrolledAt: enr?.enrolledAt || '',
    };
    for (const c of columns) {
        const raw = attrByUid[c.id];
        let val: string;
        if (sensitiveIds.has(c.id)) val = '[masked]';
        else if (raw && c.optionMap && c.optionMap[raw] != null) val = c.optionMap[raw];
        else val = raw || '';
        row[c.displayName] = val;
    }
    return row;
};

const C: Record<string, React.CSSProperties> = {
    shell: {
        background: T.bg,
        minHeight: 'calc(100vh - 96px)',
        padding: '16px 20px 24px',
        boxSizing: 'border-box',
        fontFamily: 'inherit',
        color: T.text,
    },
    headerRow: {
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 14,
        flexWrap: 'wrap',
    },
    headerLeft: { display: 'flex', alignItems: 'center', gap: 10 },
    title: { fontSize: 22, fontWeight: 700, color: T.text, margin: 0, letterSpacing: '-0.01em' },
    subtitle: { fontSize: 13, color: T.textMuted, marginTop: 2 },
    body: { display: 'flex', gap: 16, alignItems: 'stretch' },
    main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
    drawer: {
        width: 380,
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        boxShadow: T.shadow,
        padding: 16,
        position: 'sticky',
        top: 16,
        alignSelf: 'flex-start',
        maxHeight: 'calc(100vh - 140px)',
        overflowY: 'auto',
    },
    // Vitalworks Pro — compact context strip. Replaces the 6-tile grid
    // that wasted vertical space. Renders as a single-line breadcrumb of
    // program · type · counts · refresh time, with subtle dividers.
    contextStrip: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 0,
        padding: '8px 12px',
        marginBottom: 10,
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        fontSize: 12,
        color: T.textMuted,
        boxShadow: T.shadow,
    },
    contextItem: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
    },
    contextLabel: { color: T.textMuted, fontWeight: 500 },
    contextValue: { color: T.text, fontWeight: 600 },
    contextDivider: { width: 1, height: 12, background: T.border },
    // Kept for the "pick a program first" empty-state notice card.
    tile: {
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        padding: '10px 12px',
        fontSize: 13,
        color: T.text,
        boxShadow: T.shadow,
    },
    controlsRow: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        marginBottom: 12,
        flexWrap: 'wrap',
    },
    search: {
        flex: 1,
        minWidth: 240,
        padding: '8px 12px',
        fontSize: 13,
        border: `1px solid ${T.borderStrong}`,
        borderRadius: T.radiusSm,
        background: T.surface,
        color: T.text,
        outline: 'none',
    },
    btn: {
        background: T.surface,
        color: T.brand,
        border: `1px solid ${T.borderStrong}`,
        borderRadius: T.radiusSm,
        padding: '7px 12px',
        fontSize: 13,
        cursor: 'pointer',
        fontWeight: 600,
        whiteSpace: 'nowrap',
    },
    btnPrimary: {
        background: T.brand,
        color: T.textInverse,
        border: `1px solid ${T.brand}`,
        borderRadius: T.radiusSm,
        padding: '7px 14px',
        fontSize: 13,
        cursor: 'pointer',
        fontWeight: 600,
        whiteSpace: 'nowrap',
    },
    iconBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: T.surface,
        color: T.brand,
        border: `1px solid ${T.borderStrong}`,
        borderRadius: T.radiusSm,
        width: 34,
        height: 34,
        cursor: 'pointer',
    },
    pillProtected: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: T.warnSoft,
        color: T.warn,
    },
    tableWrap: {
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        boxShadow: T.shadow,
        overflow: 'hidden',
        marginBottom: 12,
    },
    tableScroll: { overflow: 'auto' },
    table: { width: '100%', borderCollapse: 'separate', borderSpacing: 0 },
    th: {
        padding: '7px 10px',
        textAlign: 'left',
        fontSize: 10.5,
        fontWeight: 700,
        background: T.bgAlt,
        borderBottom: `1px solid ${T.border}`,
        color: T.textMuted,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        position: 'sticky',
        top: 0,
        whiteSpace: 'nowrap',
        zIndex: 1,
    },
    td: {
        padding: '6px 10px',
        borderBottom: `1px solid ${T.bgAlt}`,
        fontSize: 12.5,
        color: T.text,
        lineHeight: 1.45,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: 240,
    },
    trZebra: { background: '#FAFBFC' },
    tdSelected: { background: T.brandSoft },
    mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        color: T.textMuted,
    },
    muted: { color: T.textMuted, fontSize: 12 },
    masked: {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        background: T.bgAlt,
        color: T.textMuted,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        letterSpacing: '0.15em',
    },
    pill: {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
    },
    empty: { padding: 32, textAlign: 'center', color: T.textMuted, fontSize: 14 },
    pagerRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        background: T.bgAlt,
        borderTop: `1px solid ${T.border}`,
        fontSize: 13,
        color: T.text,
        gap: 12,
        flexWrap: 'wrap',
    },
    pagerBtns: { display: 'flex', gap: 6, alignItems: 'center' },
    pagerInfo: { color: T.textMuted },
    pagerSelect: {
        padding: '4px 8px',
        border: `1px solid ${T.borderStrong}`,
        borderRadius: T.radiusSm,
        fontSize: 13,
        background: T.surface,
    },
    popover: {
        position: 'absolute',
        top: 44,
        right: 0,
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        boxShadow: T.shadow,
        padding: 12,
        zIndex: 10,
        minWidth: 240,
        maxHeight: 320,
        overflowY: 'auto',
    },
    popoverItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 4px',
        fontSize: 13,
        color: T.text,
        cursor: 'pointer',
    },
    drawerHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
    drawerTitle: { fontSize: 16, fontWeight: 700, color: T.text, margin: 0 },
    drawerSub: { fontSize: 12, color: T.textMuted, marginTop: 2 },
    drawerSection: { marginTop: 14 },
    drawerSectionTitle: {
        fontSize: 11,
        fontWeight: 700,
        color: T.textMuted,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        marginBottom: 6,
    },
    enrollmentCard: {
        border: `1px solid ${T.border}`,
        borderRadius: T.radiusSm,
        padding: 10,
        marginBottom: 8,
        fontSize: 12,
    },
    eventRow: {
        display: 'flex',
        justifyContent: 'space-between',
        padding: '6px 4px',
        borderBottom: `1px dashed ${T.bgAlt}`,
        fontSize: 12,
    },
};

const pillFor = (status?: string): React.CSSProperties => {
    if (!status) return { ...C.pill, background: T.bgAlt, color: T.textMuted };
    if (status === 'ACTIVE') return { ...C.pill, background: T.successSoft, color: T.success };
    if (status === 'COMPLETED') return { ...C.pill, background: T.infoSoft, color: T.info };
    if (status === 'CANCELLED') return { ...C.pill, background: T.dangerSoft, color: T.danger };
    return { ...C.pill, background: T.bgAlt, color: T.textMuted };
};

const ShieldLockIcon = ({ size = 16, color = T.warn }: { size?: number; color?: string }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
            d="M12 2 4 5v6c0 5 3.4 9.5 8 11 4.6-1.5 8-6 8-11V5l-8-3Z"
            fill={color}
            opacity="0.18"
        />
        <path
            d="M12 2 4 5v6c0 5 3.4 9.5 8 11 4.6-1.5 8-6 8-11V5l-8-3Z"
            stroke={color}
            strokeWidth="1.6"
            fill="none"
            strokeLinejoin="round"
        />
        <rect x="9" y="10.5" width="6" height="5" rx="1" stroke={color} strokeWidth="1.4" fill="none" />
        <path d="M10 10.5V9a2 2 0 0 1 4 0v1.5" stroke={color} strokeWidth="1.4" fill="none" />
    </svg>
);

const ColumnsIcon = ({ size = 16, color = T.brand }: { size?: number; color?: string }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="2" stroke={color} strokeWidth="1.6" />
        <path d="M9 4v16M15 4v16" stroke={color} strokeWidth="1.6" />
    </svg>
);

/**
 * Vitalworks Pro — three sort glyphs. Inactive shows a stacked up/down
 * pair (universal "sortable" affordance); active shows just the chosen
 * direction. Inline SVG keeps the bundle slim and the colour theme-able.
 */
const SortGlyph = ({
    state,
    color = T.textMuted,
    active = T.brand,
}: {
    state: 'asc' | 'desc' | 'none';
    color?: string;
    active?: string;
}) => {
    if (state === 'asc') {
        return (
            <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden>
                <path d="M5 2l3 5H2z" fill={active} />
            </svg>
        );
    }
    if (state === 'desc') {
        return (
            <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden>
                <path d="M5 8L2 3h6z" fill={active} />
            </svg>
        );
    }
    return (
        <svg width={10} height={12} viewBox="0 0 10 12" aria-hidden>
            <path d="M5 1l3 4H2z" fill={color} opacity="0.55" />
            <path d="M5 11L2 7h6z" fill={color} opacity="0.55" />
        </svg>
    );
};

const PinIcon = ({
    pinned = false,
    color = T.textMuted,
    active = T.brand,
}: {
    pinned?: boolean;
    color?: string;
    active?: string;
}) => (
    <svg width={11} height={11} viewBox="0 0 24 24" aria-hidden>
        <path
            d="M14.5 2.5l7 7-3 3-2 8L8 12.5l8-2 3-3-4.5-5z"
            fill={pinned ? active : 'none'}
            stroke={pinned ? active : color}
            strokeWidth="1.5"
            strokeLinejoin="round"
            transform="rotate(-20 12 12)"
        />
        <line
            x1="8"
            y1="14"
            x2="3"
            y2="20"
            stroke={pinned ? active : color}
            strokeWidth="1.5"
            strokeLinecap="round"
        />
    </svg>
);

/**
 * Vitalworks Pro — column header with sort + freeze affordances.
 *
 * Visual order: pin · label · sensitive-mark · sort glyph. Clicking
 * the label area cycles the sort; clicking the pin toggles freeze.
 * Each control gets its own click target so the user never has to
 * guess which area triggers what.
 */
const SortableTh = ({
    label,
    sortKey,
    sort,
    onCycle,
    pinned,
    onPin,
    rightAdornment,
    stickyStyle,
}: {
    label: string;
    sortKey: string;
    sort: { key: string; dir: 'asc' | 'desc' } | null;
    onCycle: (k: string) => void;
    pinned?: boolean;
    onPin?: () => void;
    rightAdornment?: React.ReactNode;
    stickyStyle?: React.CSSProperties;
}) => {
    const state: 'asc' | 'desc' | 'none' =
        sort && sort.key === sortKey ? sort.dir : 'none';
    return (
        <th style={{ ...C.th, cursor: 'pointer', ...(stickyStyle || {}) }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {onPin && (
                    <button
                        type="button"
                        onClick={(ev) => {
                            ev.stopPropagation();
                            onPin();
                        }}
                        title={pinned ? 'Unpin column' : 'Pin column to the left'}
                        aria-label={pinned ? 'Unpin column' : 'Pin column'}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            display: 'inline-flex',
                        }}
                    >
                        <PinIcon pinned={!!pinned} />
                    </button>
                )}
                <span
                    onClick={() => onCycle(sortKey)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') onCycle(sortKey);
                    }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                    {label}
                    {rightAdornment}
                    <SortGlyph state={state} />
                </span>
            </span>
        </th>
    );
};

const ChevronIcon = ({ rotate = 0, color = T.brand }: { rotate?: number; color?: string }) => (
    <svg
        width={14}
        height={14}
        viewBox="0 0 24 24"
        fill="none"
        style={{ transform: `rotate(${rotate}deg)`, transition: 'transform 120ms' }}
        aria-hidden
    >
        <path d="M9 6l6 6-6 6" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
);

const ME_QUERY: any = {
    me: { resource: 'me', params: { fields: 'authorities' } },
};

const SETTINGS_QUERY: any = {
    settings: {
        resource: 'systemSettings',
        params: { key: ['keyProtectedFieldsEnabled'] },
    },
};

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

/**
 * Vitalworks Pro — render an attribute cell.
 *
 * Optionset codes are resolved to displayName via `optionMap`. Sensitive
 * attributes (PII or explicitly protected) are always masked in the
 * line list; the drawer is the supported reveal path.
 */
const renderAttrValue = (
    value: string | undefined,
    attribute: string,
    sensitiveAttrIds: Set<string>,
    optionMaps: Record<string, Record<string, string>>,
) => {
    if (value == null || value === '') return <span style={C.muted}>—</span>;
    if (sensitiveAttrIds.has(attribute)) {
        return (
            <span style={C.masked} title="Sensitive — open the record to view">
                ••••••
            </span>
        );
    }
    const optMap = optionMaps[attribute];
    if (optMap && optMap[value] != null) return optMap[value];
    return value;
};

const DetailDrawer = ({
    teiUid,
    engine,
    onClose,
    history,
    stages,
    primaryName,
    orgUnitId,
    programType,
}: {
    teiUid: string;
    engine: ReturnType<typeof useDataEngine>;
    onClose: () => void;
    history: ReturnType<typeof useHistory>;
    stages: Record<string, string>;
    primaryName: string;
    orgUnitId: string;
    programType: string;
}) => {
    const [detail, setDetail] = useState<any | null>(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        setErr(null);
        engine
            .query({
                tei: {
                    resource: `tracker/trackedEntities/${teiUid}`,
                    params: {
                        fields:
                            'trackedEntity,createdAt,updatedAt,orgUnit,attributes[attribute,displayName,value],enrollments[enrollment,program,status,enrolledAt,occurredAt,events[event,programStage,status,occurredAt,dataValues[dataElement,value]]]',
                    },
                },
            })
            .then((data: any) => {
                if (!alive) return;
                setDetail(data?.tei || null);
            })
            .catch((e: any) => {
                if (!alive) return;
                setErr(e?.message || 'Failed to load detail');
            })
            .finally(() => alive && setLoading(false));
        return () => {
            alive = false;
        };
    }, [engine, teiUid]);

    return (
        <aside style={C.drawer}>
            <div style={C.drawerHead}>
                <div>
                    <h3 style={C.drawerTitle}>{primaryName || 'Record detail'}</h3>
                    <div style={C.drawerSub}>{teiUid}</div>
                </div>
                <button
                    type="button"
                    style={{ ...C.iconBtn, width: 28, height: 28 }}
                    onClick={onClose}
                    aria-label="Close detail panel"
                    title="Close"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M6 6l12 12M6 18L18 6" stroke={T.brand} strokeWidth="2" strokeLinecap="round" />
                    </svg>
                </button>
            </div>
            {loading && <div style={C.muted}>Loading detail…</div>}
            {err && <div style={{ ...C.muted, color: T.danger }}>{err}</div>}
            {detail && (
                <>
                    <div style={C.drawerSection}>
                        <div style={C.drawerSectionTitle}>Timestamps</div>
                        <div style={{ fontSize: 12, color: T.text }}>
                            Created: <strong>{fmtDate(detail.createdAt)}</strong>
                        </div>
                        <div style={{ fontSize: 12, color: T.text }}>
                            Updated: <strong>{fmtDate(detail.updatedAt)}</strong>
                        </div>
                    </div>
                    <div style={C.drawerSection}>
                        <div style={C.drawerSectionTitle}>Enrollments &amp; events</div>
                        {(detail.enrollments || []).length === 0 ? (
                            <div style={C.muted}>No enrollments.</div>
                        ) : (
                            (detail.enrollments || []).map((enr: Enrollment) => (
                                <div key={enr.enrollment} style={C.enrollmentCard}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                        <span style={pillFor(enr.status)}>{enr.status}</span>
                                        <button
                                            type="button"
                                            style={{ ...C.btn, padding: '4px 8px', fontSize: 11 }}
                                            onClick={() =>
                                                history.push(
                                                    `/enrollment?enrollmentId=${enr.enrollment}`,
                                                )
                                            }
                                        >
                                            Open
                                        </button>
                                    </div>
                                    <div style={{ fontSize: 11, color: T.textMuted }}>
                                        Enrolled: {fmtDate(enr.enrolledAt)}
                                    </div>
                                    {enr.events && enr.events.length > 0 && (
                                        <div style={{ marginTop: 8 }}>
                                            {(enr.events || []).map((ev) => (
                                                <div key={ev.event} style={C.eventRow}>
                                                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                                                        <span style={{ fontWeight: 600 }}>
                                                            {stages[ev.programStage || ''] ||
                                                                ev.programStage ||
                                                                'Event'}
                                                        </span>
                                                        <span style={C.muted}>
                                                            {fmtDate(ev.occurredAt)}
                                                        </span>
                                                    </div>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                        <span style={pillFor(ev.status)}>{ev.status || '—'}</span>
                                                        <button
                                                            type="button"
                                                            style={{ ...C.btn, padding: '2px 6px', fontSize: 11 }}
                                                            onClick={() => {
                                                                // `/viewEvent` only handles event-program events
                                                                // and throws `getEventProgramThrowIfNotFound` for
                                                                // a tracker event. Tracker (WITH_REGISTRATION)
                                                                // events go through `enrollmentEventEdit`, which
                                                                // requires the `orgUnitId` query param.
                                                                if (programType === 'WITH_REGISTRATION') {
                                                                    history.push(
                                                                        `/enrollmentEventEdit?eventId=${ev.event}&orgUnitId=${orgUnitId}`,
                                                                    );
                                                                } else {
                                                                    history.push(
                                                                        `/viewEvent?viewEventId=${ev.event}`,
                                                                    );
                                                                }
                                                            }}
                                                        >
                                                            View
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </>
            )}
        </aside>
    );
};

export const RealtimeLinelistPage = () => {
    const engine = useDataEngine();
    const history = useHistory();
    const { programId = '', orgUnitId = '' } = useLocationQuery() || {};
    const isReady = Boolean(programId && orgUnitId);

    const [payload, setPayload] = useState<FetchedPayload | null>(null);
    const [programMeta, setProgramMeta] = useState<any | null>(null);
    const [attrMeta, setAttrMeta] = useState<AttrMeta[]>([]);
    const [stages, setStages] = useState<StageMeta[]>([]);
    const [primaryAttrId, setPrimaryAttrId] = useState<string | null>(null);
    const [visibleColumns, setVisibleColumns] = useState<string[]>([]);
    const [colsOpen, setColsOpen] = useState(false);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
    const [search, setSearch] = useState('');
    const debouncedSearch = useDebounced(search, 350);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedTei, setSelectedTei] = useState<string | null>(null);
    const [exportOpen, setExportOpen] = useState(false);
    const [exportFormat, setExportFormat] = useState<'csv' | 'tsv' | 'json' | 'ndjson'>('csv');
    const [exportScope, setExportScope] = useState<'page' | 'all'>('page');
    const [exportIncludeEnrollments, setExportIncludeEnrollments] = useState(true);
    const [exportIncludeEvents, setExportIncludeEvents] = useState(true);
    const [exportIncludeRelationships, setExportIncludeRelationships] = useState(false);
    const [exportIncludeRelatedPrograms, setExportIncludeRelatedPrograms] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [exportErr, setExportErr] = useState<string | null>(null);
    /**
     * Vitalworks Pro — sort + freeze state.
     *
     * `sort.key` is either a built-in tracker field (`createdAt`,
     * `updatedAt`, `enrollmentStatus`) or a TEA attribute UID. The
     * tracker API supports `order=<field>:asc|desc`; the value is
     * passed through unchanged.
     *
     * `frozenColumns` is the *set* of column IDs that should render
     * with `position: sticky; left: <accumulated-offset>`. The TE UID
     * column is in here by default — it's the natural anchor when
     * the table scrolls horizontally past many TEA columns.
     */
    const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>({
        key: 'createdAt',
        dir: 'desc',
    });
    const [frozenColumns, setFrozenColumns] = useState<Set<string>>(
        () => new Set(['__tei__']),
    );

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

    // Vitalworks Pro — in the line list every PII / protected attribute is
    // masked **by default**, irrespective of authority or the global
    // protected-fields system setting. The list is a high-volume surface;
    // accidental disclosure is the threat we care about. The detail
    // drawer reveals individual values on demand for one record at a time.
    const sensitiveAttrIds = useMemo(
        () => new Set(attrMeta.filter((a) => a.sensitive).map((a) => a.id)),
        [attrMeta],
    );

    const stageMap = useMemo(() => {
        const m: Record<string, string> = {};
        for (const s of stages) m[s.id] = s.displayName;
        return m;
    }, [stages]);

    const optionMaps = useMemo(() => {
        const m: Record<string, Record<string, string>> = {};
        for (const a of attrMeta) {
            if (a.optionMap) m[a.id] = a.optionMap;
        }
        return m;
    }, [attrMeta]);

    // Reset pagination when scope, search, or sort changes — otherwise
    // the user can land on an empty page (e.g. page 7 of an old result
    // set that just shrunk after a new filter applied).
    useEffect(() => {
        setPage(1);
    }, [programId, orgUnitId, debouncedSearch, pageSize, sort]);

    const loadProgram = useCallback(async () => {
        if (!programId) {
            setProgramMeta(null);
            setAttrMeta([]);
            setStages([]);
            setPrimaryAttrId(null);
            setVisibleColumns([]);
            return;
        }
        try {
            const data: any = await engine.query({
                program: {
                    resource: 'programs',
                    id: programId,
                    params: {
                        fields:
                            'id,displayName,programType,trackedEntityType[id,displayName],programStages[id,displayName],programTrackedEntityAttributes[searchable,displayInList,trackedEntityAttribute[id,displayName,valueType,isProtected,confidential,optionSet[id,options[code,displayName]]]]',
                    },
                },
            });
            const prog = data?.program;
            setProgramMeta(prog);
            const ordered = (prog?.programTrackedEntityAttributes || []) as Array<any>;
            const attrs: AttrMeta[] = ordered
                .map((p: any) => ({ p, a: p?.trackedEntityAttribute }))
                .filter(({ a }) => !!a)
                .map(({ p, a }) => {
                    const opts: Array<any> = a.optionSet?.options || [];
                    const optionMap: Record<string, string> = {};
                    for (const o of opts) {
                        if (o?.code != null) optionMap[String(o.code)] = o.displayName || o.code;
                    }
                    return {
                        id: a.id,
                        displayName: a.displayName,
                        isProtected: !!a.isProtected,
                        // PII heuristic for the line list: anything explicitly
                        // flagged protected/confidential, plus the obvious
                        // identifier value-types (PHONE_NUMBER, EMAIL,
                        // PERSONAL_ID, IDENTIFIER) and any field whose name
                        // hints at it. Errs on the side of masking; the
                        // drawer surfaces the real value for the picked row.
                        sensitive: isSensitiveAttr(a),
                        displayInList: !!p.displayInList,
                        searchable: !!p.searchable,
                        optionMap: Object.keys(optionMap).length ? optionMap : undefined,
                    } as AttrMeta;
                });
            setAttrMeta(attrs);
            const primary =
                ordered.find((p) => p?.searchable)?.trackedEntityAttribute?.id ||
                ordered.find((p) => p?.displayInList)?.trackedEntityAttribute?.id ||
                ordered[0]?.trackedEntityAttribute?.id ||
                null;
            setPrimaryAttrId(primary);
            // Default columns = displayInList attrs (or first 4 if none flagged)
            const defaultCols = attrs.filter((a) => a.displayInList).map((a) => a.id);
            setVisibleColumns(defaultCols.length > 0 ? defaultCols : attrs.slice(0, 4).map((a) => a.id));
            setStages(
                (prog?.programStages || []).map((s: any) => ({
                    id: s.id,
                    displayName: s.displayName,
                })),
            );
        } catch {
            setProgramMeta(null);
        }
    }, [engine, programId]);

    // Every searchable TEA — sensitive or not. Per product direction
    // ("any variable marked as searchable MUST be searchable") the
    // line list honours the metadata flag and includes sensitive
    // attributes in the fan-out. The displayed cell value remains
    // masked; the user is only confirming whether a value they
    // already know matches. The tracker endpoint's `?query=` is
    // silently dropped on this DHIS2 build, so we fan out one
    // server-side `filter=<attrId>:LIKE:<term>` per attribute and
    // union the results client-side.
    const searchableAttrIds = useMemo(
        () => attrMeta.filter((a) => a.searchable).map((a) => a.id),
        [attrMeta],
    );

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
            // Sort: server-side via `order=<key>:<dir>`. When no sort is
            // set, default to createdAt:desc (newest first) so the page
            // still feels live.
            const orderParam = sort
                ? `${sort.key}:${sort.dir}`
                : 'createdAt:desc';
            const baseParams: Record<string, any> = {
                program: programId,
                orgUnit: orgUnitId,
                ouMode: 'DESCENDANTS',
                order: orderParam,
                fields,
            };
            const term = debouncedSearch.trim();

            // === No search term: single paginated query (existing path) ===
            if (!isTracker || !term || searchableAttrIds.length === 0) {
                const params = {
                    ...baseParams,
                    page,
                    pageSize,
                    totalPages: true,
                };
                const data: any = await engine.query({ result: { resource, params } });
                const r = data?.result || {};
                const rows = r.instances || r.trackedEntities || r.events || [];
                setPayload({
                    kind: isTracker ? 'tracker' : 'event',
                    rows,
                    total: r.total,
                    pageCount: r.pageCount,
                    page,
                    pageSize,
                    fetchedAt: new Date(),
                });
                return;
            }

            // === Search term: fan out across every searchable, non-sensitive
            // attribute and union by trackedEntity UID. ===
            const perAttrLimit = 200;
            const results = await Promise.allSettled(
                searchableAttrIds.map((attrId) =>
                    engine.query({
                        result: {
                            resource,
                            params: {
                                ...baseParams,
                                page: 1,
                                pageSize: perAttrLimit,
                                filter: `${attrId}:LIKE:${term}`,
                            },
                        },
                    }),
                ),
            );
            const seen = new Set<string>();
            const merged: TEI[] = [];
            for (const r of results) {
                if (r.status !== 'fulfilled') continue;
                const data: any = r.value;
                const rows: TEI[] =
                    data?.result?.instances || data?.result?.trackedEntities || [];
                for (const row of rows) {
                    if (!row.trackedEntity || seen.has(row.trackedEntity)) continue;
                    seen.add(row.trackedEntity);
                    merged.push(row);
                }
            }
            merged.sort((a, b) =>
                (b.createdAt || '').localeCompare(a.createdAt || ''),
            );
            // Apply client-side pagination on the merged set so the pager
            // controls continue to work for big result sets.
            const total = merged.length;
            const pageStart = (page - 1) * pageSize;
            const pageRows = merged.slice(pageStart, pageStart + pageSize);
            const pageCount = Math.max(1, Math.ceil(total / pageSize));
            setPayload({
                kind: 'tracker',
                rows: pageRows,
                total,
                pageCount,
                page,
                pageSize,
                fetchedAt: new Date(),
            });
        } catch (e: any) {
            setError(e?.message || 'Failed to fetch records');
        } finally {
            setLoading(false);
        }
    }, [engine, programMeta, isReady, programId, orgUnitId, debouncedSearch, searchableAttrIds, page, pageSize, sort]);

    useEffect(() => {
        loadProgram();
    }, [loadProgram]);

    useEffect(() => {
        if (!isReady || !programMeta) return;
        refresh();
        const id = window.setInterval(refresh, POLL_MS);
        return () => window.clearInterval(id);
    }, [isReady, programMeta, refresh]);

    // Search input is disabled only when the program has zero searchable
    // attributes. Otherwise the fan-out covers all of them.
    const searchProtectedBlocked = searchableAttrIds.length === 0;
    const searchPlaceholder = searchProtectedBlocked
        ? 'Search disabled — no searchable attributes on this program'
        : `Search across ${searchableAttrIds.length} attribute${
              searchableAttrIds.length === 1 ? '' : 's'
          }…`;

    const toggleColumn = (id: string) =>
        setVisibleColumns((prev) =>
            prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
        );

    /**
     * Click a column header → cycle the sort: none → asc → desc → none.
     * The `__tei__` synthetic key sorts by TE UID, which the tracker
     * endpoint doesn't actually support; we silently fall back to
     * `createdAt` for that case.
     */
    const cycleSort = (key: string) => {
        setSort((prev) => {
            if (!prev || prev.key !== key) return { key, dir: 'asc' };
            if (prev.dir === 'asc') return { key, dir: 'desc' };
            return null;
        });
    };

    const toggleFreeze = (id: string) =>
        setFrozenColumns((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    /**
     * Build a left-offset map for every frozen column so multiple
     * pinned columns stack flush. Order follows the actual table-column
     * order (TE UID first, then visible TEA columns).
     */
    const freezeOffsets = useMemo(() => {
        const offsets: Record<string, number> = {};
        let offset = 0;
        const WIDTH_TEI = 130;
        const WIDTH_ATTR = 180;
        const order: string[] = ['__tei__', ...visibleColumns];
        for (const id of order) {
            if (frozenColumns.has(id)) {
                offsets[id] = offset;
                offset += id === '__tei__' ? WIDTH_TEI : WIDTH_ATTR;
            }
        }
        return offsets;
    }, [frozenColumns, visibleColumns]);

    const stickyTh = (id: string): React.CSSProperties => {
        if (!frozenColumns.has(id)) return {};
        return {
            position: 'sticky',
            left: freezeOffsets[id] ?? 0,
            zIndex: 3,
            background: T.bgAlt,
            boxShadow: '1px 0 0 ' + T.border,
        };
    };
    const stickyTd = (id: string, baseBg?: string): React.CSSProperties => {
        if (!frozenColumns.has(id)) return {};
        return {
            position: 'sticky',
            left: freezeOffsets[id] ?? 0,
            zIndex: 1,
            background: baseBg || T.surface,
            boxShadow: '1px 0 0 ' + T.border,
        };
    };

    // Single ordered list used for the header row, the cell row, AND
    // the export flattener. Eliminates the "column header doesn't match
    // value" bug we hit when the two loops drifted apart.
    const orderedColumns: AttrMeta[] = useMemo(() => {
        const byId: Record<string, AttrMeta> = {};
        for (const a of attrMeta) byId[a.id] = a;
        return visibleColumns.map((id) => byId[id]).filter(Boolean);
    }, [attrMeta, visibleColumns]);

    /**
     * Vitalworks Pro — export records in the user-chosen format.
     *
     * Scope=page reuses what's already on screen (no extra network).
     * Scope=all walks every page (capped at 5,000 rows server-side) and
     * lets the user include nested enrollments / events / relationships
     * (one expensive query, two for related-program enrollments).
     *
     * Output:
     *   csv / tsv → one row per TEI, columns mirror the on-screen
     *               columns (resolved optionsets, masked PII).
     *   json     → hierarchical {records: [...], generatedAt, scope,
     *               program} so the consumer keeps nested data.
     *   ndjson   → newline-delimited JSON for line-by-line ingest.
     */
    const doExport = useCallback(async () => {
        if (!isReady || !payload || !programMeta) return;
        setExporting(true);
        setExportErr(null);
        try {
            const isTracker = payload.kind === 'tracker';
            // Compose the field expression based on what the user opted into.
            const baseTeiFields =
                'trackedEntity,trackedEntityType,createdAt,updatedAt,orgUnit,attributes[attribute,displayName,value]';
            const eventFields = exportIncludeEvents
                ? 'events[event,programStage,status,occurredAt,createdAt,dataValues[dataElement,value]]'
                : '';
            const relFields = exportIncludeRelationships
                ? 'relationships[relationship,relationshipType,createdAt,from,to]'
                : '';
            const enrollmentFields = exportIncludeEnrollments
                ? `enrollments[enrollment,program,status,enrolledAt,occurredAt${
                      eventFields ? ',' + eventFields : ''
                  }${relFields ? ',' + relFields : ''}]`
                : '';
            const fields = [baseTeiFields, enrollmentFields].filter(Boolean).join(',');

            let rows: Array<TEI | EventRow> = [];
            const term = debouncedSearch.trim();
            const HARD_CAP = 5000;

            if (exportScope === 'page') {
                if (isTracker && (exportIncludeEnrollments || exportIncludeRelationships || exportIncludeEvents)) {
                    // Re-fetch each TEI on the current page individually
                    // with expanded fields. Single-UID lookups bypass the
                    // multi-attribute search problem and keep the export
                    // grouped exactly as it appears on screen.
                    const uids = (payload.rows as TEI[])
                        .map((t) => t.trackedEntity)
                        .filter(Boolean);
                    const fetched: TEI[] = [];
                    const BATCH = 10;
                    for (let i = 0; i < uids.length; i += BATCH) {
                        const slice = uids.slice(i, i + BATCH);
                        const settled = await Promise.allSettled(
                            slice.map((uid) =>
                                engine.query({
                                    tei: {
                                        resource: `tracker/trackedEntities/${uid}`,
                                        params: { fields },
                                    },
                                }),
                            ),
                        );
                        for (const r of settled) {
                            if (r.status === 'fulfilled') {
                                const data: any = r.value;
                                if (data?.tei) fetched.push(data.tei);
                            }
                        }
                    }
                    rows = fetched;
                } else {
                    rows = payload.rows;
                }
            } else if (isTracker && term && searchableAttrIds.length > 0) {
                // scope === 'all' with a search term → fan out across
                // every searchable, non-sensitive attribute and union.
                const perAttrLimit = 1000;
                const settled = await Promise.allSettled(
                    searchableAttrIds.map((attrId) =>
                        engine.query({
                            result: {
                                resource: 'tracker/trackedEntities',
                                params: {
                                    program: programId,
                                    orgUnit: orgUnitId,
                                    ouMode: 'DESCENDANTS',
                                    page: 1,
                                    pageSize: perAttrLimit,
                                    order: 'createdAt:desc',
                                    fields,
                                    filter: `${attrId}:LIKE:${term}`,
                                },
                            },
                        }),
                    ),
                );
                const seen = new Set<string>();
                const merged: TEI[] = [];
                for (const r of settled) {
                    if (r.status !== 'fulfilled') continue;
                    const data: any = r.value;
                    const batch: TEI[] =
                        data?.result?.instances || data?.result?.trackedEntities || [];
                    for (const row of batch) {
                        if (!row.trackedEntity || seen.has(row.trackedEntity)) continue;
                        seen.add(row.trackedEntity);
                        merged.push(row);
                        if (merged.length >= HARD_CAP) break;
                    }
                    if (merged.length >= HARD_CAP) break;
                }
                merged.sort((a, b) =>
                    (b.createdAt || '').localeCompare(a.createdAt || ''),
                );
                rows = merged;
            } else {
                // scope === 'all', no search → walk pages of 500 up to the
                // 5000-row hard cap. Same self-guard rationale: users that
                // need whole-tenant exports should use the analytics
                // export pipeline.
                const allRows: Array<TEI | EventRow> = [];
                let p = 1;
                const pSize = 500;
                while (allRows.length < HARD_CAP) {
                    const params: Record<string, any> = {
                        program: programId,
                        orgUnit: orgUnitId,
                        ouMode: 'DESCENDANTS',
                        page: p,
                        pageSize: pSize,
                        order: 'createdAt:desc',
                        fields: isTracker
                            ? fields
                            : 'event,program,programStage,orgUnit,status,occurredAt,createdAt,updatedAt,dataValues[dataElement,value]',
                    };
                    const data: any = await engine.query({
                        result: {
                            resource: isTracker ? 'tracker/trackedEntities' : 'tracker/events',
                            params,
                        },
                    });
                    const batch =
                        data?.result?.instances ||
                        data?.result?.trackedEntities ||
                        data?.result?.events ||
                        [];
                    if (batch.length === 0) break;
                    allRows.push(...batch);
                    if (batch.length < pSize) break;
                    p++;
                }
                rows = allRows.slice(0, HARD_CAP);
            }

            // Optionally enrich each TEI with its other-program
            // enrollments. Fired in parallel batches of 10 to keep the
            // total request count bounded.
            if (isTracker && exportIncludeRelatedPrograms && rows.length > 0) {
                const teis = rows as TEI[];
                const seenProgs = new Set<string>([programId]);
                const fetchOne = async (uid: string) => {
                    try {
                        const data: any = await engine.query({
                            other: {
                                resource: `tracker/trackedEntities/${uid}`,
                                params: {
                                    fields:
                                        'trackedEntity,enrollments[enrollment,program,status,enrolledAt,occurredAt]',
                                },
                            },
                        });
                        const others = (data?.other?.enrollments || []).filter(
                            (e: any) => e.program && !seenProgs.has(e.program),
                        );
                        const target = teis.find((t) => t.trackedEntity === uid);
                        if (target) (target as any).otherProgramEnrollments = others;
                    } catch {
                        /* best effort */
                    }
                };
                const BATCH = 10;
                for (let i = 0; i < teis.length; i += BATCH) {
                    await Promise.all(teis.slice(i, i + BATCH).map((t) => fetchOne(t.trackedEntity)));
                }
            }

            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const baseName = `live-records-${programId}-${ts}`;

            if (exportFormat === 'json') {
                const out = {
                    generatedAt: new Date().toISOString(),
                    program: { id: programId, name: programMeta?.displayName, type: programMeta?.programType },
                    orgUnit: orgUnitId,
                    scope: exportScope,
                    include: {
                        enrollments: exportIncludeEnrollments,
                        events: exportIncludeEvents,
                        relationships: exportIncludeRelationships,
                        relatedPrograms: exportIncludeRelatedPrograms,
                    },
                    records: rows,
                };
                triggerDownload(`${baseName}.json`, 'application/json', JSON.stringify(out, null, 2));
            } else if (exportFormat === 'ndjson') {
                const lines = rows.map((r) => JSON.stringify(r)).join('\n');
                triggerDownload(`${baseName}.ndjson`, 'application/x-ndjson', lines);
            } else {
                // csv / tsv — flatten via the same column ordering shown
                // on screen so the file matches what the user just saw.
                const flat = isTracker
                    ? (rows as TEI[]).map((t) =>
                          flattenTei(t, orderedColumns, sensitiveAttrIds, optionMaps),
                      )
                    : (rows as EventRow[]).map((ev) => ({
                          event: ev.event,
                          program: ev.program || '',
                          programStage: ev.programStage || '',
                          orgUnit: ev.orgUnit || '',
                          status: ev.status || '',
                          occurredAt: ev.occurredAt || '',
                          createdAt: ev.createdAt || '',
                          updatedAt: ev.updatedAt || '',
                          dataValueCount: (ev.dataValues || []).length,
                      }));
                if (flat.length === 0) {
                    triggerDownload(
                        `${baseName}.${exportFormat}`,
                        'text/plain',
                        '(no records to export)',
                    );
                } else {
                    const headers = Object.keys(flat[0]);
                    const sep = exportFormat === 'tsv' ? '\t' : ',';
                    const esc = exportFormat === 'tsv' ? tsvEscape : csvEscape;
                    const lines = [
                        headers.join(sep),
                        ...flat.map((row) => headers.map((h) => esc((row as any)[h])).join(sep)),
                    ];
                    triggerDownload(
                        `${baseName}.${exportFormat}`,
                        exportFormat === 'tsv' ? 'text/tab-separated-values' : 'text/csv',
                        lines.join('\n'),
                    );
                }
            }
            setExportOpen(false);
        } catch (e: any) {
            setExportErr(e?.message || 'Export failed');
        } finally {
            setExporting(false);
        }
    }, [
        isReady,
        payload,
        programMeta,
        programId,
        orgUnitId,
        exportFormat,
        exportScope,
        exportIncludeEnrollments,
        exportIncludeEvents,
        exportIncludeRelationships,
        exportIncludeRelatedPrograms,
        engine,
        page,
        pageSize,
        debouncedSearch,
        searchableAttrIds,
        sensitiveAttrIds,
        orderedColumns,
        optionMaps,
    ]);

    const selectedTeiObj = useMemo(
        () =>
            payload?.kind === 'tracker'
                ? (payload.rows as TEI[]).find((t) => t.trackedEntity === selectedTei) || null
                : null,
        [payload, selectedTei],
    );

    const renderTeiRow = (
        tei: TEI,
        columns: AttrMeta[],
        index: number,
        stickyTdFn?: (id: string, baseBg?: string) => React.CSSProperties,
    ) => {
        const selected = tei.trackedEntity === selectedTei;
        const zebra = !selected && index % 2 === 1 ? C.trZebra : {};
        const tdStyle = selected ? { ...C.td, ...C.tdSelected } : { ...C.td, ...zebra };
        const rowBg = selected
            ? T.brandSoft
            : index % 2 === 1
            ? '#FAFBFC'
            : T.surface;
        const attrByUid: Record<string, string> = {};
        for (const a of tei.attributes || []) attrByUid[a.attribute] = a.value;
        const e = tei.enrollments?.[0];
        return (
            <tr
                key={tei.trackedEntity}
                onClick={() => setSelectedTei(tei.trackedEntity)}
                style={{ cursor: 'pointer' }}
            >
                <td style={{ ...tdStyle, ...(stickyTdFn ? stickyTdFn('__tei__', rowBg) : {}) }}>
                    <span style={C.mono}>{tei.trackedEntity}</span>
                </td>
                {/* Iterate the *same* `columns` array the header uses so
                  * the two never drift apart when the user toggles
                  * column visibility. */}
                {columns.map((col) => (
                    <td
                        key={col.id}
                        style={{ ...tdStyle, ...(stickyTdFn ? stickyTdFn(col.id, rowBg) : {}) }}
                    >
                        {renderAttrValue(attrByUid[col.id], col.id, sensitiveAttrIds, optionMaps)}
                    </td>
                ))}
                <td style={tdStyle}>
                    {e ? <span style={pillFor(e.status)}>{e.status}</span> : <span style={C.muted}>—</span>}
                </td>
                <td style={tdStyle}>{fmtDate(tei.createdAt)}</td>
                <td style={tdStyle}>{fmtDate(tei.updatedAt)}</td>
                <td style={tdStyle}>
                    <button
                        type="button"
                        style={C.btn}
                        onClick={(ev) => {
                            ev.stopPropagation();
                            if (e) history.push(`/enrollment?enrollmentId=${e.enrollment}`);
                        }}
                        disabled={!e}
                    >
                        Open
                    </button>
                </td>
            </tr>
        );
    };

    const renderEventRow = (ev: EventRow) => (
        <tr key={ev.event}>
            <td style={C.td}>
                <span style={C.mono}>{ev.event}</span>
            </td>
            <td style={C.td}>
                <span style={pillFor(ev.status)}>{ev.status || '—'}</span>
            </td>
            <td style={C.td}>{stageMap[ev.programStage || ''] || ev.programStage || '—'}</td>
            <td style={C.td}>{fmtDate(ev.occurredAt)}</td>
            <td style={C.td}>{fmtDate(ev.createdAt)}</td>
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

    const pageCount = payload?.pageCount || (payload?.total ? Math.ceil(payload.total / pageSize) : 0);
    const showDrawer = payload?.kind === 'tracker' && selectedTei && selectedTeiObj;
    const sensitiveCount = orderedColumns.filter((c) => c.sensitive).length;

    return (
        <>
            <TopBar programId={programId} orgUnitId={orgUnitId} selectedCategories={undefined} />
            <div style={C.shell}>
                <div style={C.headerRow}>
                    <div style={C.headerLeft}>
                        <div>
                            <h1 style={C.title}>Live records</h1>
                            <div style={C.subtitle}>
                                Realtime line listing — reads tracker tables directly, refreshes every{' '}
                                {POLL_MS / 1000}s.
                            </div>
                        </div>
                        {(protectedFieldsEnabled || sensitiveCount > 0) && (
                            <span
                                style={C.pillProtected}
                                title={`${sensitiveCount || 0} sensitive attribute${
                                    sensitiveCount === 1 ? '' : 's'
                                } masked. Open a record to view the actual values.`}
                            >
                                <ShieldLockIcon size={14} />
                                Protected data
                            </span>
                        )}
                    </div>
                </div>

                <div style={C.contextStrip}>
                    <span style={C.contextItem}>
                        <span style={C.contextLabel}>Program</span>
                        <span style={C.contextValue}>
                            {programMeta?.displayName || programId || '—'}
                        </span>
                    </span>
                    <span style={C.contextDivider} />
                    <span style={C.contextItem}>
                        <span style={C.contextLabel}>Type</span>
                        <span style={C.contextValue}>
                            {programMeta?.programType
                                ? programMeta.programType.replace('_', ' ').toLowerCase()
                                : '—'}
                        </span>
                    </span>
                    <span style={C.contextDivider} />
                    <span style={C.contextItem}>
                        <span style={C.contextLabel}>Page</span>
                        <span style={C.contextValue}>
                            {page}
                            {pageCount ? ` / ${pageCount}` : ''}
                        </span>
                    </span>
                    <span style={C.contextDivider} />
                    <span style={C.contextItem}>
                        <span style={C.contextLabel}>Showing</span>
                        <span style={C.contextValue}>
                            {payload?.rows.length ?? 0}
                            {payload?.total ? ` of ${payload.total}` : ''}
                        </span>
                    </span>
                    <span style={C.contextDivider} />
                    <span style={C.contextItem}>
                        <span style={C.contextLabel}>Refreshed</span>
                        <span style={C.contextValue}>
                            {payload?.fetchedAt
                                ? new Date(payload.fetchedAt).toLocaleTimeString(undefined, {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                  })
                                : '—'}
                        </span>
                    </span>
                </div>

                <div style={{ ...C.controlsRow, position: 'relative' }}>
                    <input
                        type="search"
                        style={C.search}
                        placeholder={searchPlaceholder}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        disabled={!isReady || searchProtectedBlocked}
                        aria-label="Search records"
                    />
                    <button
                        type="button"
                        style={C.btn}
                        onClick={() => history.push(`/search?programId=${programId}&orgUnitId=${orgUnitId}`)}
                        title="Open the full advanced search experience"
                    >
                        Advanced search
                    </button>
                    <button
                        type="button"
                        style={C.iconBtn}
                        onClick={() => setColsOpen((v) => !v)}
                        aria-label="Manage columns"
                        title="Manage columns"
                    >
                        <ColumnsIcon />
                    </button>
                    <button
                        type="button"
                        style={C.btn}
                        onClick={() => setExportOpen((v) => !v)}
                        aria-label="Export records"
                        title="Export records"
                        disabled={!payload || payload.rows.length === 0}
                    >
                        Export…
                    </button>
                    <button
                        type="button"
                        style={C.btn}
                        onClick={() => history.push(`/?programId=${programId}&orgUnitId=${orgUnitId}`)}
                    >
                        Working list
                    </button>
                    <button
                        type="button"
                        style={C.btnPrimary}
                        onClick={refresh}
                        disabled={loading || !isReady}
                    >
                        {loading ? 'Refreshing…' : 'Refresh now'}
                    </button>
                    {colsOpen && (
                        <div style={C.popover}>
                            <div style={{ ...C.drawerSectionTitle, marginBottom: 8 }}>Columns</div>
                            {attrMeta.length === 0 ? (
                                <div style={C.muted}>No attributes available.</div>
                            ) : (
                                attrMeta.map((a) => (
                                    <label key={a.id} style={C.popoverItem}>
                                        <input
                                            type="checkbox"
                                            checked={visibleColumns.includes(a.id)}
                                            onChange={() => toggleColumn(a.id)}
                                        />
                                        <span>
                                            {a.displayName}
                                            {a.sensitive && (
                                                <span
                                                    style={{ marginLeft: 6 }}
                                                    title="Sensitive — masked in the list"
                                                >
                                                    <ShieldLockIcon size={12} />
                                                </span>
                                            )}
                                        </span>
                                    </label>
                                ))
                            )}
                        </div>
                    )}
                    {exportOpen && (
                        <div style={{ ...C.popover, minWidth: 300 }}>
                            <div style={{ ...C.drawerSectionTitle, marginBottom: 8 }}>Export</div>
                            <div style={{ ...C.drawerSectionTitle, marginTop: 6 }}>Format</div>
                            {(['csv', 'tsv', 'json', 'ndjson'] as const).map((f) => (
                                <label key={f} style={C.popoverItem}>
                                    <input
                                        type="radio"
                                        name="vw-export-fmt"
                                        checked={exportFormat === f}
                                        onChange={() => setExportFormat(f)}
                                    />
                                    <span style={{ textTransform: 'uppercase', fontSize: 12 }}>
                                        {f}
                                    </span>
                                    <span style={{ ...C.muted, marginLeft: 6 }}>
                                        {f === 'csv'
                                            ? 'comma-separated, opens in Excel / Sheets'
                                            : f === 'tsv'
                                            ? 'tab-separated, safest for clipboards'
                                            : f === 'json'
                                            ? 'hierarchical, keeps nested sections'
                                            : 'one JSON record per line (ingest pipelines)'}
                                    </span>
                                </label>
                            ))}
                            <div style={{ ...C.drawerSectionTitle, marginTop: 10 }}>Scope</div>
                            {(['page', 'all'] as const).map((s) => (
                                <label key={s} style={C.popoverItem}>
                                    <input
                                        type="radio"
                                        name="vw-export-scope"
                                        checked={exportScope === s}
                                        onChange={() => setExportScope(s)}
                                    />
                                    <span>
                                        {s === 'page'
                                            ? `Current page (${payload?.rows.length ?? 0} rows)`
                                            : `All matching records${
                                                  payload?.total ? ` (≤${Math.min(payload.total, 5000)})` : ''
                                              }`}
                                    </span>
                                </label>
                            ))}
                            {payload?.kind === 'tracker' && (exportFormat === 'json' || exportFormat === 'ndjson') && (
                                <>
                                    <div style={{ ...C.drawerSectionTitle, marginTop: 10 }}>
                                        Include nested sections
                                    </div>
                                    <label style={C.popoverItem}>
                                        <input
                                            type="checkbox"
                                            checked={exportIncludeEnrollments}
                                            onChange={() => setExportIncludeEnrollments((v) => !v)}
                                        />
                                        <span>Enrollments</span>
                                    </label>
                                    <label style={C.popoverItem}>
                                        <input
                                            type="checkbox"
                                            checked={exportIncludeEvents}
                                            onChange={() => setExportIncludeEvents((v) => !v)}
                                            disabled={!exportIncludeEnrollments}
                                        />
                                        <span>Events (per enrollment)</span>
                                    </label>
                                    <label style={C.popoverItem}>
                                        <input
                                            type="checkbox"
                                            checked={exportIncludeRelationships}
                                            onChange={() => setExportIncludeRelationships((v) => !v)}
                                            disabled={!exportIncludeEnrollments}
                                        />
                                        <span>Relationships</span>
                                    </label>
                                    <label style={C.popoverItem}>
                                        <input
                                            type="checkbox"
                                            checked={exportIncludeRelatedPrograms}
                                            onChange={() => setExportIncludeRelatedPrograms((v) => !v)}
                                        />
                                        <span>Other-program enrollments</span>
                                    </label>
                                </>
                            )}
                            {exportErr && (
                                <div
                                    style={{
                                        marginTop: 8,
                                        padding: '6px 8px',
                                        background: T.dangerSoft,
                                        color: T.danger,
                                        borderRadius: T.radiusSm,
                                        fontSize: 12,
                                    }}
                                >
                                    {exportErr}
                                </div>
                            )}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
                                <button
                                    type="button"
                                    style={C.btn}
                                    onClick={() => setExportOpen(false)}
                                    disabled={exporting}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    style={C.btnPrimary}
                                    onClick={doExport}
                                    disabled={exporting}
                                >
                                    {exporting ? 'Exporting…' : 'Export'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {!isReady && (
                    <div style={{ ...C.tile, marginBottom: 12 }}>
                        Pick a program and org unit in the bar above (or append{' '}
                        <code>?programId=…&orgUnitId=…</code> to the URL).
                    </div>
                )}

                {error && (
                    <div
                        style={{
                            padding: '10px 14px',
                            background: T.dangerSoft,
                            border: `1px solid ${T.danger}`,
                            color: T.danger,
                            borderRadius: T.radiusSm,
                            marginBottom: 12,
                            fontSize: 13,
                        }}
                    >
                        Could not load records: {error}
                    </div>
                )}

                <div style={C.body}>
                    <div style={C.main}>
                        <div style={C.tableWrap}>
                            <div style={C.tableScroll}>
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
                                                <SortableTh
                                                    label="Tracked Entity"
                                                    sortKey="__tei__"
                                                    sort={sort}
                                                    onCycle={cycleSort}
                                                    pinned={frozenColumns.has('__tei__')}
                                                    onPin={() => toggleFreeze('__tei__')}
                                                    stickyStyle={stickyTh('__tei__')}
                                                />
                                                {orderedColumns.map((a) => (
                                                    <SortableTh
                                                        key={a.id}
                                                        label={a.displayName}
                                                        sortKey={a.id}
                                                        sort={sort}
                                                        onCycle={cycleSort}
                                                        pinned={frozenColumns.has(a.id)}
                                                        onPin={() => toggleFreeze(a.id)}
                                                        rightAdornment={
                                                            a.sensitive ? (
                                                                <span
                                                                    style={{ marginLeft: 4 }}
                                                                    title="Sensitive — masked"
                                                                >
                                                                    <ShieldLockIcon size={11} />
                                                                </span>
                                                            ) : null
                                                        }
                                                        stickyStyle={stickyTh(a.id)}
                                                    />
                                                ))}
                                                <SortableTh
                                                    label="Status"
                                                    sortKey="enrollmentStatus"
                                                    sort={sort}
                                                    onCycle={cycleSort}
                                                />
                                                <SortableTh
                                                    label="Created"
                                                    sortKey="createdAt"
                                                    sort={sort}
                                                    onCycle={cycleSort}
                                                />
                                                <SortableTh
                                                    label="Updated"
                                                    sortKey="updatedAt"
                                                    sort={sort}
                                                    onCycle={cycleSort}
                                                />
                                                <th style={C.th}></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {(payload.rows as TEI[]).map((tei, i) =>
                                                renderTeiRow(
                                                    tei,
                                                    orderedColumns,
                                                    i,
                                                    stickyTd,
                                                ),
                                            )}
                                        </tbody>
                                    </table>
                                ) : payload && payload.kind === 'event' ? (
                                    <table style={C.table}>
                                        <thead>
                                            <tr>
                                                <th style={C.th}>Event</th>
                                                <th style={C.th}>Status</th>
                                                <th style={C.th}>Stage</th>
                                                <th style={C.th}>Occurred at</th>
                                                <th style={C.th}>Created</th>
                                                <th style={C.th}>Values</th>
                                                <th style={C.th}></th>
                                            </tr>
                                        </thead>
                                        <tbody>{(payload.rows as EventRow[]).map(renderEventRow)}</tbody>
                                    </table>
                                ) : null}
                            </div>
                            {payload && (
                                <div style={C.pagerRow}>
                                    <div style={C.pagerInfo}>
                                        Showing page <strong>{page}</strong>
                                        {pageCount ? <> of <strong>{pageCount}</strong></> : null}
                                        {payload.total ? <> · {payload.total} total</> : null}
                                    </div>
                                    <div style={C.pagerBtns}>
                                        <label style={C.muted} htmlFor="vw-pagesize">
                                            Page size
                                        </label>
                                        <select
                                            id="vw-pagesize"
                                            style={C.pagerSelect}
                                            value={pageSize}
                                            onChange={(e) => setPageSize(parseInt(e.target.value, 10))}
                                        >
                                            {PAGE_SIZE_OPTIONS.map((n) => (
                                                <option key={n} value={n}>
                                                    {n}
                                                </option>
                                            ))}
                                        </select>
                                        <button
                                            type="button"
                                            style={C.btn}
                                            disabled={page <= 1 || loading}
                                            onClick={() => setPage(1)}
                                            aria-label="First page"
                                        >
                                            «
                                        </button>
                                        <button
                                            type="button"
                                            style={C.btn}
                                            disabled={page <= 1 || loading}
                                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                                            aria-label="Previous page"
                                        >
                                            <ChevronIcon rotate={180} />
                                        </button>
                                        <button
                                            type="button"
                                            style={C.btn}
                                            disabled={(pageCount > 0 && page >= pageCount) || loading}
                                            onClick={() =>
                                                setPage((p) => (pageCount ? Math.min(pageCount, p + 1) : p + 1))
                                            }
                                            aria-label="Next page"
                                        >
                                            <ChevronIcon />
                                        </button>
                                        {pageCount > 0 && (
                                            <button
                                                type="button"
                                                style={C.btn}
                                                disabled={page >= pageCount || loading}
                                                onClick={() => setPage(pageCount)}
                                                aria-label="Last page"
                                            >
                                                »
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    {showDrawer && (
                        <DetailDrawer
                            teiUid={selectedTei!}
                            engine={engine}
                            onClose={() => setSelectedTei(null)}
                            history={history}
                            stages={stageMap}
                            orgUnitId={orgUnitId}
                            programType={programMeta?.programType || ''}
                            primaryName={
                                primaryAttrId && selectedTeiObj
                                    ? selectedTeiObj.attributes?.find(
                                          (a) => a.attribute === primaryAttrId,
                                      )?.value || ''
                                    : ''
                            }
                        />
                    )}
                </div>
            </div>
        </>
    );
};
