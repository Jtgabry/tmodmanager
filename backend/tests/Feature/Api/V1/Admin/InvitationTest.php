<?php

namespace Tests\Feature\Api\V1\Admin;

use App\Models\Invitation;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class InvitationTest extends TestCase
{
    use RefreshDatabase;

    public function test_admin_creates_an_invitation_and_gets_the_link_once(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());

        $response = $this->postJson(route('api.v1.admin.invitations.store'), ['email' => 'amico@example.com', 'expiresInDays' => 3])
            ->assertCreated()
            ->assertJsonPath('data.status', 'active')
            ->assertJsonPath('data.email', 'amico@example.com');

        $token = str($response->json('url'))->after('invite=')->toString();
        $this->assertNotNull(Invitation::findUsable($token));
        $this->assertDatabaseMissing('invitations', ['token_hash' => $token]);

        $this->getJson(route('api.v1.admin.invitations.index'))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonMissingPath('data.0.url');
    }

    public function test_invitation_expiry_is_limited(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());

        $this->postJson(route('api.v1.admin.invitations.store'), ['expiresInDays' => 365])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('expiresInDays');
    }

    public function test_admin_can_revoke_an_invitation(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        $invitation = Invitation::factory()->create();

        $this->deleteJson(route('api.v1.admin.invitations.destroy', $invitation))->assertNoContent();

        $this->assertModelMissing($invitation);
    }

    public function test_non_admins_cannot_create_invitations(): void
    {
        Sanctum::actingAs(User::factory()->create());

        $this->postJson(route('api.v1.admin.invitations.store'))->assertForbidden();

        $this->assertDatabaseCount('invitations', 0);
    }
}
