const classify = (state) => {
    if (state.status === 'current')
        return 'current';
    // TODO Lane 2 stage 5: when capture events carry stored DOM
    // evidence + an extractor manifest entry whose extractorVersion >
    // the latest revision's, classify as 'stored-reextract'. For now,
    // every stale source needs the user to revisit the live provider.
    return 'live-provider';
};
export const planExtractionUpgrade = async (store) => {
    const all = await store.listAllSources();
    const bySource = new Map();
    let current = 0;
    let storedReextract = 0;
    let liveProvider = 0;
    let notUpgradeable = 0;
    for (const state of all) {
        const status = classify(state);
        bySource.set(state.sourceUnitId, status);
        switch (status) {
            case 'current':
                current += 1;
                break;
            case 'stored-reextract':
                storedReextract += 1;
                break;
            case 'live-provider':
                liveProvider += 1;
                break;
            case 'not-upgradeable':
                notUpgradeable += 1;
                break;
        }
    }
    return {
        bySource,
        counts: { current, storedReextract, liveProvider, notUpgradeable },
    };
};
//# sourceMappingURL=stalePlanner.js.map