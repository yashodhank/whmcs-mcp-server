/**
 * B1 — canonical WHMCS GetContacts mapper. Synthetic fixtures ONLY
 * (example.com / *.test / John Doe).
 *
 * A contact is a client sub-record carrying per-person PII. Pins:
 *  - defensive parsing (string numbers/booleans, single-object lists,
 *    contacts.contact nesting, flat `contact` fallback, empty {}/[])
 *  - field classification (name → pii.name, email → pii.email, phone →
 *    pii.phone, postal address → pii.address, company → business.label,
 *    permission flags → public.safe; NO secrets emitted)
 *  - classmap completeness: every emitted data path has a FieldClass
 */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalContact,
  mapToCanonicalContacts,
} from '../../src/canonical/contact.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalContact (single)', () => {
  it('maps + classifies a typical contact row, coercing string numbers/booleans', () => {
    const raw = {
      id: '7',
      userid: '42',
      firstname: 'John',
      lastname: 'Doe',
      companyname: 'Acme Test Ltd',
      email: 'john@example.com',
      phonenumber: '+1-000-000-0000',
      address1: '1 Test St',
      address2: 'Suite 9',
      city: 'Testville',
      state: 'TS',
      postcode: '00000',
      country: 'US',
      subaccount: '1',
      permissions: 'manageproducts,managedomains',
    };
    const c = mapToCanonicalContact(raw);
    // Contacts are packaged under the owning 'client' entity (frozen union).
    expect(c.entity).toBe('client');
    expect(c.data.contactId).toBe(7);
    expect(c.data.clientId).toBe(42);
    expect(c.data.firstName).toBe('John');
    expect(c.data.lastName).toBe('Doe');
    expect(c.data.email).toBe('john@example.com');
    expect(c.data.phoneNumber).toBe('+1-000-000-0000');
    expect(c.data.address1).toBe('1 Test St');
    expect(c.data.country).toBe('US');
    expect(c.data.companyName).toBe('Acme Test Ltd');
    expect(c.data.subAccount).toBe(true);
    expect(c.data.permissions).toBe('manageproducts,managedomains');

    expect(c.classes.contactId).toBe('business.identifier');
    expect(c.classes.clientId).toBe('business.identifier');
    expect(c.classes.firstName).toBe('pii.name');
    expect(c.classes.lastName).toBe('pii.name');
    expect(c.classes.email).toBe('pii.email');
    expect(c.classes.phoneNumber).toBe('pii.phone');
    expect(c.classes.address1).toBe('pii.address');
    expect(c.classes.postcode).toBe('pii.address');
    // Company is a display label, NOT a person's PII.
    expect(c.classes.companyName).toBe('business.label');
    expect(c.classes.subAccount).toBe('public.safe');
    expect(c.classes.permissions).toBe('public.safe');
    assertClassmapComplete(c);
  });

  it('null/garbage → all-null record, complete classmap, no throw', () => {
    const c = mapToCanonicalContact(null);
    expect(c.entity).toBe('client');
    expect(c.data.contactId).toBeNull();
    expect(c.data.email).toBeNull();
    expect(c.data.subAccount).toBeNull();
    assertClassmapComplete(c);
  });

  it('falls back to contactid / clientid spellings', () => {
    const c = mapToCanonicalContact({ contactid: 5, clientid: 9 });
    expect(c.data.contactId).toBe(5);
    expect(c.data.clientId).toBe(9);
  });
});

describe('mapToCanonicalContacts (list)', () => {
  it('unwraps contacts.contact array', () => {
    const raw = {
      result: 'success',
      totalresults: 2,
      contacts: {
        contact: [
          { id: 1, firstname: 'A', email: 'a@example.com' },
          { id: 2, firstname: 'B', email: 'b@example.test' },
        ],
      },
    };
    const list = mapToCanonicalContacts(raw);
    expect(list.map((c) => c.data.contactId)).toEqual([1, 2]);
    expect(list[1].data.email).toBe('b@example.test');
    list.forEach((c) => assertClassmapComplete(c));
  });

  it('tolerates a single contact object (not wrapped in an array)', () => {
    const raw = { contacts: { contact: { id: 7, firstname: 'solo' } } };
    const list = mapToCanonicalContacts(raw);
    expect(list).toHaveLength(1);
    expect(list[0].data.contactId).toBe(7);
    expect(list[0].data.firstName).toBe('solo');
  });

  it('accepts a flat top-level `contact` fallback', () => {
    const raw = { contact: [{ id: 3 }] };
    const list = mapToCanonicalContacts(raw);
    expect(list.map((c) => c.data.contactId)).toEqual([3]);
  });

  it('empty → empty list', () => {
    expect(mapToCanonicalContacts({ contacts: {} })).toEqual([]);
    expect(mapToCanonicalContacts(null)).toEqual([]);
  });
});
