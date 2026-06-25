# Replace ckb-transaction-dumper with ccc-based implementation

## TL;DR

> **Quick Summary**: Replace `ckb-transaction-dumper` npm package with a pure ccc-based implementation.
>
> **Deliverables**:
>
> - New `src/tools/ckb-tx-dumper.ts` (replaces old implementation)
> - Removed `ckb-transaction-dumper` from package.json
>
> **Estimated Effort**: Medium (2-3 hours)
> **Parallel Execution**: NO - sequential

---

## Context

### Request

Replace `ckb-transaction-dumper` with ccc-based implementation (no external dependencies, use ccc throughout).

### Current Implementation

- `src/tools/ckb-tx-dumper.ts` spawns `ckb-transaction-dumper` binary
- Depends on npm package `ckb-transaction-dumper@0.4.2`

### What TransactionDumper Does

1. Load transaction (from file or fetch by hash)
2. Resolve cell deps (handle dep_group type)
3. Resolve inputs
4. Output mock transaction JSON for ckb-debugger

### ccc Molecule Support

ccc provides full molecule codec:

- `ccc.molecule.struct()` - for OutPoint { tx_hash, index }
- `ccc.molecule.vector()` - for OutPointVec
- `ccc.Byte32`, `ccc.Uint32LE` - predefined codecs

No manual bytes parsing needed!

---

## Work Objectives

### Core Objective

Replace `ckb-transaction-dumper` with pure ccc implementation.

### Must Have

- Keep `DumpOption` interface
- Keep `dumpTransaction()` signature
- Same JSON output format

### Must NOT Have

- Breaking API changes
- New dependencies

---

## TODOs

- [ ] 1. Implement ccc-based transaction dumper

  **What to do**:

  - Rewrite `src/tools/ckb-tx-dumper.ts`
  - Use ccc Client for RPC calls
  - Use ccc molecule codecs for dep_group unpacking

  **Key implementation**:

  ```typescript
  import { ccc } from '@ckb-ccc/core';

  // OutPoint codec for dep_group unpacking
  const OutPointCodec = ccc.molecule.struct({
    txHash: ccc.Byte32,
    index: ccc.Uint32LE,
  });

  const OutPointVecCodec = ccc.molecule.vector(OutPointCodec);

  // Unpack dep_group data
  function unpackDepGroup(data: string): ccc.OutPoint[] {
    return OutPointVecCodec.decode(data).map((o) =>
      ccc.OutPoint.from({ txHash: o.txHash, index: '0x' + o.index.toString(16) }),
    );
  }
  ```

  **Acceptance Criteria**:

  - [ ] Uses ccc Client for RPC
  - [ ] Uses ccc molecule for dep_group
  - [ ] Same output format

  **QA Scenarios**:

  ```
  Scenario: Compiles successfully
    Tool: Bash
    Steps: npm run typecheck
    Expected: No errors
  ```

  **Commit**: `feat: implement transaction dumper with ccc`

---

- [ ] 2. Remove ckb-transaction-dumper dependency

  **What to do**:

  - Remove from `package.json`
  - Run `pnpm install`

  **Commit**: `chore: remove ckb-transaction-dumper`

---

## Verification

```bash
npm run typecheck
npm run lint
grep -c "ckb-transaction-dumper" package.json || echo "Clean"
```

## Key Implementation Notes

### Dep Group Unpacking with ccc

```typescript
const OutPointCodec = ccc.molecule.struct({
  txHash: ccc.Byte32,
  index: ccc.Uint32LE,
});
const OutPointVecCodec = ccc.molecule.vector(OutPointCodec);

// Usage
const outpoints = OutPointVecCodec.decode(cellData);
```

### Mock Transaction Structure

```typescript
interface MockTransaction {
  mock_info: {
    inputs: MockInput[];
    cell_deps: MockCellDep[];
    header_deps: any[];
  };
  tx: Transaction;
}
```

### Algorithm

1. Load tx from file
2. For each cell_dep:
   - Fetch cell
   - If dep_type === 'dep_group':
     - Decode cell.data as OutPointVec
     - Fetch each referenced cell
   - Add to mock_info.cell_deps
3. For each input:
   - Fetch referenced cell
   - Add to mock_info.inputs
4. Write JSON output
