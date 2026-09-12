/**
 * Tests for 403 sub-classification (Phase A).
 *
 * Proofs:
 *  - "Invalid IP x.x.x.x" → forbiddenKind: 'invalid_ip'
 *  - "Invalid Permissions: ..." → forbiddenKind: 'invalid_permissions'
 *  - 403 with no body → forbiddenKind: 'waf_or_empty'
 *  - 403 with unrecognized body → forbiddenKind: 'unknown'
 *  - Non-403 status → no forbiddenKind
 */

import axios from 'axios';
import { describe, it, expect } from 'vitest';
import { classifyWhmcsError, type ForbiddenKind } from '../../src/whmcs/request/classifier.js';

function make403AxiosError(data: unknown): unknown {
  const error = new axios.AxiosError(
    'Request failed with status code 403',
    '403',
    undefined,
    {},
    {
      status: 403,
      statusText: 'Forbidden',
      headers: {},
      config: {} as never,
      data,
    }
  );
  return error;
}

function make500AxiosError(): unknown {
  return new axios.AxiosError(
    'Request failed with status code 500',
    '500',
    undefined,
    {},
    {
      status: 500,
      statusText: 'Internal Server Error',
      headers: {},
      config: {} as never,
      data: 'Server Error',
    }
  );
}

describe('403 sub-classification', () => {
  it('classifies Invalid IP as invalid_ip', () => {
    const error = make403AxiosError({
      result: 'error',
      message: 'Invalid IP 104.30.180.111',
    });
    const classified = classifyWhmcsError(error);
    expect(classified.statusCode).toBe(403);
    expect(classified.forbiddenKind).toBe('invalid_ip' satisfies ForbiddenKind);
    expect(classified.reportedIp).toBe('104.30.180.111');
  });

  it('classifies Invalid Permissions as invalid_permissions', () => {
    const error = make403AxiosError({
      result: 'error',
      message: 'Invalid Permissions: API action "whmcsdetails" is not allowed',
    });
    const classified = classifyWhmcsError(error);
    expect(classified.statusCode).toBe(403);
    expect(classified.forbiddenKind).toBe('invalid_permissions' satisfies ForbiddenKind);
    expect(classified.reportedIp).toBeUndefined();
  });

  it('classifies empty-body 403 as waf_or_empty', () => {
    const error = make403AxiosError('');
    const classified = classifyWhmcsError(error);
    expect(classified.statusCode).toBe(403);
    expect(classified.forbiddenKind).toBe('waf_or_empty' satisfies ForbiddenKind);
    expect(classified.hasResponseBody).toBe(false);
  });

  it('classifies null-body 403 as waf_or_empty', () => {
    const error = make403AxiosError(null);
    const classified = classifyWhmcsError(error);
    expect(classified.statusCode).toBe(403);
    expect(classified.forbiddenKind).toBe('waf_or_empty' satisfies ForbiddenKind);
  });

  it('classifies unrecognized-body 403 as unknown', () => {
    const error = make403AxiosError({
      result: 'error',
      message: 'Some other 403 reason',
    });
    const classified = classifyWhmcsError(error);
    expect(classified.statusCode).toBe(403);
    expect(classified.forbiddenKind).toBe('unknown' satisfies ForbiddenKind);
  });

  it('does not set forbiddenKind for non-403 errors', () => {
    const error = make500AxiosError();
    const classified = classifyWhmcsError(error);
    expect(classified.statusCode).toBe(500);
    expect(classified.forbiddenKind).toBeUndefined();
  });

  it('classifies string-body Invalid IP', () => {
    const error = make403AxiosError('Invalid IP 10.0.0.1');
    const classified = classifyWhmcsError(error);
    expect(classified.statusCode).toBe(403);
    expect(classified.forbiddenKind).toBe('invalid_ip' satisfies ForbiddenKind);
    expect(classified.reportedIp).toBe('10.0.0.1');
  });

  it('classifies string-body Invalid Permissions', () => {
    const error = make403AxiosError('Invalid Permissions: API action "WhmcsDetails" is not allowed');
    const classified = classifyWhmcsError(error);
    expect(classified.statusCode).toBe(403);
    expect(classified.forbiddenKind).toBe('invalid_permissions' satisfies ForbiddenKind);
  });
});
