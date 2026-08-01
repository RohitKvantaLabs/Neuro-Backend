const { parsePhoneAndCountryCode } = require('../src/utils/phoneUtils');

describe('Phone Normalization & Parsing', () => {
  it('correctly normalizes Indian phone numbers with greedy frontend split', () => {
    // Frontend splitPhone greedily turns +919588034682 into cc: "+9195", phone: "88034682"
    const result = parsePhoneAndCountryCode('+9195', '88034682');
    expect(result.countryCode).toBe('+91');
    expect(result.phone).toBe('9588034682');
  });

  it('correctly normalizes standard separate country code and phone', () => {
    const result = parsePhoneAndCountryCode('+91', '9588034682');
    expect(result.countryCode).toBe('+91');
    expect(result.phone).toBe('9588034682');
  });

  it('correctly normalizes US phone numbers with greedy frontend split', () => {
    const result = parsePhoneAndCountryCode('+1415', '5550001');
    expect(result.countryCode).toBe('+1');
    expect(result.phone).toBe('4155550001');
  });

  it('correctly normalizes Nigeria 3-digit country code (+234)', () => {
    const result = parsePhoneAndCountryCode('+23480', '12345678');
    expect(result.countryCode).toBe('+234');
    expect(result.phone).toBe('8012345678');
  });

  it('handles null / empty inputs gracefully', () => {
    const result = parsePhoneAndCountryCode(null, null);
    expect(result.countryCode).toBeNull();
    expect(result.phone).toBeNull();
  });
});
