import { describe, expect, it } from 'vitest';
import { container, makeInstance, snap } from './helpers';

describe('controlled view restore source admission', () => {
  it.each(['snapshot', 'ingestion', 'dataRef'] as const)(
    'discards a staged view when %s changes the source before acknowledgement',
    async (change) => {
      const { instance } = makeInstance({ fitViewOnFirstData: false });
      try {
        await instance.attach(container);
        const ingestRevision = async (revision: number) => {
          const ingest = instance.beginIngest({
            purpose: 'replace', datasetKey: 'ds', sourceRevision: revision,
            baseModelRevision: instance.getRevisions().model,
          });
          const replacement = snap(revision, ['a', 'b'], [['a', 'b']]);
          await ingest.append({ sequence: 0, batchId: `revision-${revision}`, nodes: replacement.nodes, edges: replacement.edges });
          await ingest.commit();
        };
        if (change === 'ingestion') await ingestRevision(1);
        instance.applyHostUpdate({
          ...(change === 'ingestion' ? {} : { data: snap(1, ['a', 'b'], [['a', 'b']]) }),
          dataRef: { branch: 'main', revision: 1 },
          selection: [],
        });
        instance.on('viewStateRestore', () => {});
        const pending = instance.setViewState({
          ...instance.getViewState(),
          selection: { nodeIds: ['a'], edgeIds: [], groupIds: [] },
          hiddenNodeIds: ['b'],
          subgraph: { seedIds: ['a'], hops: 0 },
          layout: { kind: 'fixed' },
        });

        if (change === 'snapshot') {
          instance.applyHostUpdate({ data: snap(2, ['a', 'b'], [['a', 'b']]) });
        } else if (change === 'ingestion') {
          await ingestRevision(2);
        } else {
          instance.applyHostUpdate({ dataRef: { branch: 'main', revision: 2 } });
        }

        let settled = false;
        void pending.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(true);

        // A late but otherwise matching controlled acknowledgement cannot
        // commit the stale internal commands or layout into the new source.
        instance.applyHostUpdate({ selection: ['a'] });
        await expect(pending).resolves.toMatchObject({ status: 'rejected', code: 'restore-diverged' });
        expect(instance.store.getState().hiddenNodeIds.size).toBe(0);
        expect(instance.store.getState().scope).toBeNull();
        expect(instance.getSceneNodeIds()).toEqual(['a', 'b']);
        expect(instance.getViewState().layout.kind).toBe('force');
        expect(instance.store.getState().history).toEqual({ undoDepth: 0, redoDepth: 0 });
      } finally { instance.destroy(); }
    },
  );

  it('admits a matching acknowledgement after an equivalent reference and replayed snapshot', async () => {
    const { instance } = makeInstance({ fitViewOnFirstData: false });
    try {
      instance.applyHostUpdate({
        data: snap(1, ['a', 'b']), dataRef: { branch: 'main', revision: 1 }, selection: [],
      });
      instance.on('viewStateRestore', () => {});
      const pending = instance.setViewState({
        ...instance.getViewState(),
        selection: { nodeIds: ['a'], edgeIds: [], groupIds: [] }, hiddenNodeIds: ['b'],
      });
      instance.applyHostUpdate({ data: snap(1, ['a', 'b']), dataRef: { revision: 1, branch: 'main' } });
      instance.applyHostUpdate({ selection: ['a'] });
      await expect(pending).resolves.toEqual({ status: 'applied' });
      expect([...instance.store.getState().hiddenNodeIds]).toEqual(['b']);
    } finally { instance.destroy(); }
  });
});
