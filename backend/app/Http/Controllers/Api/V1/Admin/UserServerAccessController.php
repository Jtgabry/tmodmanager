<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\UpdateServerAccessRequest;
use App\Http\Resources\UserResource;
use App\Models\User;

/**
 * Permessi di un utente su un singolo server. "view" è implicito nell'avere un accesso.
 */
class UserServerAccessController extends Controller
{
    public function update(UpdateServerAccessRequest $request, User $user, string $server): UserResource
    {
        $user->serverAccesses()->updateOrCreate(
            ['server_id' => $server],
            ['abilities' => array_values(array_diff($request->validated('abilities'), ['view']))],
        );

        return new UserResource($user->load('serverAccesses'));
    }

    public function destroy(User $user, string $server): UserResource
    {
        $user->serverAccesses()->where('server_id', $server)->delete();

        return new UserResource($user->load('serverAccesses'));
    }
}
