import { NextResponse, type NextRequest } from 'next/server';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { errorResponse } from '@/lib/services/http';
import { UpdateProductProfileSchema } from '@/lib/services/product-profile-schema';
import {
  archiveProductProfile,
  getProductProfile,
  updateProductProfile,
} from '@/lib/services/product-profile';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspaceContext();
    const { id: idStr } = await params;
    const id = parseId(idStr);
    const profile = await getProductProfile(ctx, id);
    return NextResponse.json({ profile: serializeProfile(profile) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspaceContext();
    const { id: idStr } = await params;
    const id = parseId(idStr);
    const body = await req.json();
    const input = UpdateProductProfileSchema.parse(body);
    const profile = await updateProductProfile(ctx, id, input);
    return NextResponse.json({ profile: serializeProfile(profile) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspaceContext();
    const { id: idStr } = await params;
    const id = parseId(idStr);
    const profile = await archiveProductProfile(ctx, id);
    return NextResponse.json({ profile: serializeProfile(profile) });
  } catch (err) {
    return errorResponse(err);
  }
}

function parseId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw Object.assign(new Error('id must be a positive integer'), {
      name: 'ZodError',
      issues: [{ code: 'custom', path: ['id'], message: 'must be a positive integer' }],
    });
  }
  return BigInt(raw);
}

function serializeProfile<T extends { id: bigint; workspaceId: bigint }>(p: T) {
  return {
    ...p,
    id: p.id.toString(),
    workspaceId: p.workspaceId.toString(),
  };
}
