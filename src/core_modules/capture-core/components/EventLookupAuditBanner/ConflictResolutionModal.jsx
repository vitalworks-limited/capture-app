/* eslint-disable */
/**
 * Vitalworks Pro — Wave-4 conflict-resolution modal for
 * ASSIGN_VALUE_FROM_EVENT_LOOKUP rule actions configured with
 * conflictPolicy = PROMPT_USER_TO_SELECT.
 *
 * Flow:
 *  1. Banner shows a conflict row. User clicks "Resolve…" → this modal opens.
 *  2. Modal fetches the program rule action config via
 *     /api/programRuleActions/<uid> (gets scope, source DE, etc.)
 *  3. Modal POSTs /api/tracker/rules/lookup/candidates with the action
 *     config + current event context — gets the full list of candidate
 *     events that carry a value for the source DE.
 *  4. User picks a candidate; we PATCH the current event's data value via
 *     POST /api/tracker?async=false&importStrategy=UPDATE.
 *  5. Banner refreshes (parent invalidates the audit query); the audit
 *     writer records the manual selection on the next reconciliation pass.
 *
 * Intentionally minimal — no Redux integration, no rule-engine wiring;
 * the lookup is fully server-side and the picker is just UX. Errors at any
 * step fail closed (modal stays open with the existing list) so the user
 * is never silently denied a write that they think succeeded.
 */
import React, { useState, useEffect } from 'react';
import i18n from '@dhis2/d2-i18n';
import { useDataEngine } from '@dhis2/app-runtime';
import {
    Modal,
    ModalTitle,
    ModalContent,
    ModalActions,
    Button,
    ButtonStrip,
    Card,
    CircularLoader,
    NoticeBox,
} from '@dhis2/ui';

const ACTION_QUERY = uid => ({
    resource: 'programRuleActions',
    id: uid,
    params: { fields: '*,sourceDataElement[id],dataElement[id],sourceProgramStages[id],sourcePrograms[id]' },
});

function buildLookupRequest(action, ctx) {
    return {
        currentEventUid: ctx.eventId,
        currentEnrollmentUid: ctx.enrollmentId,
        currentProgramStageUid: ctx.programStageUid,
        sourceDataElementUid:
            (action.sourceDataElement && action.sourceDataElement.id) ||
            ctx.sourceDataElementUid,
        targetDataElementUid:
            (action.dataElement && action.dataElement.id) ||
            ctx.targetDataElementUid,
        scope: action.eventLookupScope,
        sourceProgramStageMode: action.sourceProgramStageMode,
        sourceProgramStageUids: (action.sourceProgramStages || []).map(s => s.id),
        sourceProgramUids: (action.sourcePrograms || []).map(p => p.id),
        temporalMode: action.temporalMode,
        selectionStrategy: action.selectionStrategy,
        sourceEventStatusFilter: action.sourceEventStatusFilter,
        sourceEventFilterExpression: action.sourceEventFilterExpression,
        maxLookbackEvents: action.maxLookbackEvents,
        relationshipTypeUid: action.relationshipTypeUid,
        relationshipDirection: action.relationshipDirection,
    };
}

export const ConflictResolutionModal = ({
    open,
    onClose,
    onResolved,
    programRuleActionUid,
    eventId,
    enrollmentId,
    programStageUid,
    targetDataElementUid,
}) => {
    const engine = useDataEngine();
    const [candidates, setCandidates] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [picking, setPicking] = useState(false);

    useEffect(() => {
        if (!open || !programRuleActionUid) return;
        let cancelled = false;
        async function load() {
            setLoading(true);
            setError(null);
            try {
                const { action } = await engine.query({
                    action: ACTION_QUERY(programRuleActionUid),
                });
                const request = buildLookupRequest(action, {
                    eventId,
                    enrollmentId,
                    programStageUid,
                    targetDataElementUid,
                });
                const { res } = await engine.mutate({
                    resource: 'tracker/rules/lookup/candidates',
                    type: 'create',
                    data: request,
                }).then(r => ({ res: r })).catch(e => ({ res: { __error: e } }));
                if (cancelled) return;
                if (res && res.__error) {
                    setError(res.__error.message || i18n.t('Failed to load candidates'));
                } else {
                    setCandidates((res && res.candidates) || []);
                }
            } catch (e) {
                if (!cancelled) setError(e.message || i18n.t('Failed to load action config'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => { cancelled = true; };
    }, [open, programRuleActionUid, eventId, enrollmentId, programStageUid, targetDataElementUid, engine]);

    async function pick(candidate) {
        if (!candidate || !targetDataElementUid || !eventId) return;
        setPicking(true);
        setError(null);
        try {
            await engine.mutate({
                resource: 'tracker?async=false&importStrategy=UPDATE',
                type: 'create',
                data: {
                    events: [
                        {
                            event: eventId,
                            dataValues: [
                                {
                                    dataElement: targetDataElementUid,
                                    value: candidate.value,
                                },
                            ],
                        },
                    ],
                },
            });
            if (onResolved) onResolved(candidate);
            onClose();
        } catch (e) {
            setError(e.message || i18n.t('Failed to write the chosen value'));
        } finally {
            setPicking(false);
        }
    }

    if (!open) return null;
    return (
        <Modal onClose={onClose} large>
            <ModalTitle>{i18n.t('Resolve lookup conflict')}</ModalTitle>
            <ModalContent>
                {loading && <CircularLoader small />}
                {error && (
                    <NoticeBox error title={i18n.t('Error')}>
                        {error}
                    </NoticeBox>
                )}
                {!loading && !error && candidates.length === 0 && (
                    <NoticeBox warning title={i18n.t('No candidates')}>
                        {i18n.t('No candidate events were returned by the server.')}
                    </NoticeBox>
                )}
                {!loading && candidates.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {candidates.map(c => (
                            <Card key={c.eventUid}>
                                <div style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div>
                                        <div style={{ fontSize: 16, fontWeight: 500 }}>{c.value}</div>
                                        <div style={{ fontSize: 12, color: '#666' }}>
                                            {i18n.t('Event {{event}} · stage {{stage}} · {{when}}', {
                                                event: c.eventUid,
                                                stage: c.programStageUid,
                                                when: c.occurredAt ? new Date(c.occurredAt).toISOString().slice(0, 10) : '',
                                            })}
                                        </div>
                                    </div>
                                    <Button
                                        primary
                                        small
                                        loading={picking}
                                        onClick={() => pick(c)}
                                    >
                                        {i18n.t('Use this value')}
                                    </Button>
                                </div>
                            </Card>
                        ))}
                    </div>
                )}
            </ModalContent>
            <ModalActions>
                <ButtonStrip end>
                    <Button onClick={onClose} disabled={picking}>{i18n.t('Cancel')}</Button>
                </ButtonStrip>
            </ModalActions>
        </Modal>
    );
};

export default ConflictResolutionModal;
