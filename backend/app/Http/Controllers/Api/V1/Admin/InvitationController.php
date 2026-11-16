<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\StoreInvitationRequest;
use App\Http\Resources\InvitationResource;
use App\Models\Invitation;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Http\Response;

class InvitationController extends Controller
{
    public function index(): AnonymousResourceCollection
    {
        return InvitationResource::collection(
            Invitation::query()->with(['creator', 'usedBy'])->latest()->limit(100)->get(),
        );
    }

    /**
     * Il link con il token in chiaro viene restituito solo qui: nel database c'è solo l'hash.
     */
    public function store(StoreInvitationRequest $request): JsonResponse
    {
        ['invitation' => $invitation, 'token' => $token] = Invitation::issue(
            $request->user(),
            $request->validated('email'),
            now()->addDays((int) $request->validated('expiresInDays', 7)),
        );

        return (new InvitationResource($invitation->load('creator')))
            ->additional(['url' => url('/register?invite='.$token)])
            ->response()
            ->setStatusCode(201);
    }

    public function destroy(Invitation $invitation): Response
    {
        $invitation->delete();

        return response()->noContent();
    }
}
