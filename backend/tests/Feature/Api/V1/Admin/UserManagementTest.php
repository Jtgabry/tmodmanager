<?php

namespace Tests\Feature\Api\V1\Admin;

use App\Enums\ServerAbility;
use App\Models\ServerAccess;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class UserManagementTest extends TestCase
{
    use RefreshDatabase;

    public function test_non_admins_cannot_manage_users(): void
    {
        $target = User::factory()->pending()->create();
        Sanctum::actingAs(User::factory()->create());

        $this->getJson(route('api.v1.admin.users.index'))->assertForbidden();
        $this->patchJson(route('api.v1.admin.users.update', $target), ['isApproved' => true])->assertForbidden();
        $this->putJson(route('api.v1.admin.users.servers.update', [$target, 'alfa']), ['abilities' => []])->assertForbidden();

        $this->assertNull($target->fresh()->approved_at);
    }

    public function test_admin_lists_pending_users_first_with_their_server_access(): void
    {
        $admin = $this->actingAsAdmin();
        $pending = User::factory()->pending()->create(['name' => 'Zeta']);
        $member = User::factory()->create(['name' => 'Alfa']);
        ServerAccess::factory()->for($member)->abilities([ServerAbility::Console])->create();

        $this->getJson(route('api.v1.admin.users.index'))
            ->assertOk()
            ->assertJsonPath('data.0.id', $pending->id)
            ->assertJsonPath('data.1.servers', ['alfa' => ['console', 'view']])
            ->assertJsonPath('data.2.id', $admin->id)
            ->assertJsonPath('data.2.servers', null);
    }

    public function test_admin_can_approve_and_promote_users(): void
    {
        $this->actingAsAdmin();
        $user = User::factory()->pending()->create();

        $this->patchJson(route('api.v1.admin.users.update', $user), ['isApproved' => true, 'isAdmin' => true])
            ->assertOk()
            ->assertJsonPath('data.isApproved', true)
            ->assertJsonPath('data.isAdmin', true);
    }

    public function test_revoking_approval_logs_the_user_out(): void
    {
        $this->actingAsAdmin();
        $user = User::factory()->create();
        $user->createToken('test');

        $this->patchJson(route('api.v1.admin.users.update', $user), ['isApproved' => false])->assertOk();

        $this->assertNull($user->fresh()->approved_at);
        $this->assertSame(0, $user->tokens()->count());
    }

    public function test_admin_cannot_demote_or_delete_themselves(): void
    {
        $admin = $this->actingAsAdmin();

        $this->patchJson(route('api.v1.admin.users.update', $admin), ['isAdmin' => false])->assertUnprocessable();
        $this->deleteJson(route('api.v1.admin.users.destroy', $admin))->assertUnprocessable();

        $this->assertTrue($admin->fresh()->is_admin);
    }

    public function test_admin_can_delete_other_users(): void
    {
        $this->actingAsAdmin();
        $user = User::factory()->create();

        $this->deleteJson(route('api.v1.admin.users.destroy', $user))->assertNoContent();

        $this->assertModelMissing($user);
    }

    public function test_admin_sets_and_removes_server_abilities(): void
    {
        $this->actingAsAdmin();
        $user = User::factory()->create();

        $this->putJson(route('api.v1.admin.users.servers.update', [$user, 'alfa']), ['abilities' => ['power', 'view', 'files']])
            ->assertOk()
            ->assertJsonPath('data.servers.alfa', ['power', 'files', 'view']);

        $this->assertTrue($user->fresh()->hasServerAbility('alfa', ServerAbility::Files));
        $this->assertFalse($user->fresh()->hasServerAbility('alfa', ServerAbility::Console));

        $this->deleteJson(route('api.v1.admin.users.servers.destroy', [$user, 'alfa']))
            ->assertOk()
            ->assertJsonPath('data.servers', []);
    }

    public function test_unknown_abilities_are_rejected(): void
    {
        $this->actingAsAdmin();
        $user = User::factory()->create();

        $this->putJson(route('api.v1.admin.users.servers.update', [$user, 'alfa']), ['abilities' => ['root']])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('abilities.0');
    }

    private function actingAsAdmin(): User
    {
        $admin = User::factory()->admin()->create(['name' => 'Mario']);
        Sanctum::actingAs($admin);

        return $admin;
    }
}
