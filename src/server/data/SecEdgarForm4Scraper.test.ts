/**
 * SecEdgarForm4Scraper.test.ts
 *
 * Tests the pure Form 4 XML parser with a synthetic fixture (parsing logic only -
 * never presented as market evidence). Network paths are not tested here.
 */
import { describe, it, expect } from 'vitest';
import { parseForm4Xml } from './SecEdgarForm4Scraper';

const FIXTURE_XML = `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerName>DOE JOHN</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <officerTitle>Chief Executive Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-10-01</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>150.25</value></transactionPricePerShare>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>50000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership>D</directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-10-02</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>200</value></transactionShares>
        <transactionPricePerShare><value>151.00</value></transactionPricePerShare>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>49800</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership>I</directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

describe('parseForm4Xml', () => {
  it('extracts both transactions with correct fields', () => {
    const txns = parseForm4Xml(FIXTURE_XML, '000123456789', '0000320193', 'AAPL', '2026-10-03');
    expect(txns).toHaveLength(2);

    expect(txns[0].ticker).toBe('AAPL');
    expect(txns[0].insiderName).toBe('DOE JOHN');
    expect(txns[0].insiderTitle).toBe('Chief Executive Officer');
    expect(txns[0].transactionCode).toBe('P');
    expect(txns[0].shares).toBe(1000);
    expect(txns[0].pricePerShare).toBe(150.25);
    expect(txns[0].sharesOwnedAfter).toBe(50000);
    expect(txns[0].isDirect).toBe(true);
    expect(txns[0].transactionDate).toBe('2026-10-01');

    expect(txns[1].transactionCode).toBe('S');
    expect(txns[1].isDirect).toBe(false);
    expect(txns[1].shares).toBe(200);
  });

  it('returns empty for malformed XML without ownershipDocument', () => {
    expect(parseForm4Xml('<foo/>', 'acc', 'cik', 'T', '2026-10-03')).toEqual([]);
  });

  it('returns empty when there is no nonDerivativeTable', () => {
    const xml = '<ownershipDocument><reportingOwner></reportingOwner></ownershipDocument>';
    expect(parseForm4Xml(xml, 'acc', 'cik', 'T', '2026-10-03')).toEqual([]);
  });

  it('handles single transaction (non-array) correctly', () => {
    const singleXml = `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>SMITH JANE</rptOwnerName></reportingOwnerId>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-10-01</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>500</value></transactionShares>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;
    const txns = parseForm4Xml(singleXml, 'acc', 'cik', 'T', '2026-10-03');
    expect(txns).toHaveLength(1);
    expect(txns[0].transactionCode).toBe('P');
    expect(txns[0].shares).toBe(500);
    expect(txns[0].insiderName).toBe('SMITH JANE');
  });
});
