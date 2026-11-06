# Soroban contract tests

These are Mocha specifications written against the Soroban test harness
(`ledger.createAccount`, `contract.deploy`, …) rather than against EVM
artifacts.

They live outside `Contracts/test/` on purpose: `hardhat test` collects every
JavaScript file under its `test` path and loads it, so a Soroban spec requires
APIs that do not exist in a Hardhat runtime (`@stellar/stellar-sdk` exports
neither `ledger` nor `contract`) and aborts the whole run before any Solidity
test executes.

Run the Solidity suites with:

```bash
npx hardhat test
```

Run these specs with the harness that provides the Soroban helpers.
