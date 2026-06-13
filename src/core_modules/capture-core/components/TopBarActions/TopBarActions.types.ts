export type Props = {
    onOpenNewRegistrationPage?: () => void;
    selectedProgramId?: string | null;
    selectedOrgUnitId?: string;
    isUserInteractionInProgress?: boolean;
};

export type PlainProps = {
    selectedProgramId?: string | null;
    /**
     * Vitalworks Pro — passed through so the "Live records" button can
     * deep-link into the realtime line listing while preserving the
     * currently-selected org unit.
     */
    selectedOrgUnitId?: string;
    onNewClick: () => void;
    onNewClickWithoutProgramId: () => void;
    onFindClick: () => void;
    onFindClickWithoutProgramId: () => void;
    openConfirmDialog: boolean;
};

