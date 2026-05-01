import { NextResponse, type NextRequest } from 'next/server';
import { getWorkspaceContext } from '@/lib/services/auth-context';
import { errorResponse } from '@/lib/services/http';
import { CreateProductProfileSchema } from '@/lib/services/product-profile-schema';
import {
  createProductProfile,
  listProductProfiles,
} from '@/lib/services/product-profile';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getWorkspaceContext();
    const includeArchived = req.nextUrl.searchParams.get('archived') === 'true';
    const profiles = await listProductProfiles(ctx, { includeArchived });
    // bigint -> string for JSON serialization
    return NextResponse.json({
      profiles: profiles.map(serializeProfile),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getWorkspaceContext();
    const body = await req.json();
    const input = CreateProductProfileSchema.parse(body);
    const profile = await createProductProfile(ctx, input);
    return NextResponse.json({ profile: serializeProfile(profile) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

function serializeProfile<T extends { id: bigint; workspaceId: bigint }>(p: T) {
  return {
    ...p,
    id: p.id.toString(),
    workspaceId: p.workspaceId.toString(),
  };
}
