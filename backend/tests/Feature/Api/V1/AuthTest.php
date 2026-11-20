<?php

namespace Tests\Feature\Api\V1;

use App\Models\Invitation;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AuthTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        // Come il browser: Sanctum attiva la sessione solo per richieste dal dominio della SPA.
        $this->withHeader('Referer', config('app.url'));
    }

    public function test_approved_user_can_log_in_and_fetch_their_profile(): void
    {
        $user = User::factory()->create(['email' => 'utente@example.com']);

        $this->postJson(route('api.v1.auth.login'), ['email' => 'utente@example.com', 'password' => 'password'])
            ->assertOk()
            ->assertJsonPath('data.email', 'utente@example.com');

        $this->assertAuthenticatedAs($user);
        $this->getJson(route('api.v1.auth.user'))->assertOk()->assertJsonPath('data.id', $user->id);
    }

    public function test_login_fails_with_wrong_password(): void
    {
        User::factory()->create(['email' => 'utente@example.com']);

        $this->postJson(route('api.v1.auth.login'), ['email' => 'utente@example.com', 'password' => 'sbagliata'])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('email');

        $this->assertGuest();
    }

    public function test_login_is_rate_limited_after_five_failures(): void
    {
        User::factory()->create(['email' => 'utente@example.com']);

        foreach (range(1, 5) as $attempt) {
            $this->postJson(route('api.v1.auth.login'), ['email' => 'utente@example.com', 'password' => 'sbagliata']);
        }

        $this->postJson(route('api.v1.auth.login'), ['email' => 'utente@example.com', 'password' => 'password'])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['email' => 'Too many attempts']);

        $this->assertGuest();
    }

    public function test_pending_user_cannot_log_in(): void
    {
        User::factory()->pending()->create(['email' => 'nuovo@example.com']);

        $this->postJson(route('api.v1.auth.login'), ['email' => 'nuovo@example.com', 'password' => 'password'])
            ->assertForbidden()
            ->assertJsonPath('error', 'not_approved');

        $this->assertGuest();
    }

    public function test_logout_ends_the_session(): void
    {
        $this->actingAs(User::factory()->create());

        $this->postJson(route('api.v1.auth.logout'))->assertNoContent();

        $this->assertGuest('web');
    }

    public function test_registration_without_invitation_stays_pending(): void
    {
        User::factory()->admin()->create();

        $this->postJson(route('api.v1.auth.register'), $this->registration())
            ->assertCreated()
            ->assertExactJson(['status' => 'pending']);

        $this->assertGuest();
        $this->assertNull(User::firstWhere('email', 'nuovo@example.com')->approved_at);
    }

    public function test_registration_with_invitation_is_approved_and_logged_in(): void
    {
        $invitation = Invitation::factory()->withToken('token-valido')->create();

        $this->postJson(route('api.v1.auth.register'), $this->registration(['invitation' => 'token-valido']))
            ->assertCreated()
            ->assertJsonPath('status', 'active')
            ->assertJsonPath('user.isApproved', true);

        $user = User::firstWhere('email', 'nuovo@example.com');
        $this->assertAuthenticatedAs($user);
        $this->assertTrue($invitation->fresh()->usedBy->is($user));
    }

    public function test_registration_rejects_used_or_expired_invitations(): void
    {
        Invitation::factory()->withToken('usato')->used()->create();
        Invitation::factory()->withToken('scaduto')->expired()->create();

        foreach (['usato', 'scaduto', 'inesistente'] as $token) {
            $this->postJson(route('api.v1.auth.register'), $this->registration(['invitation' => $token]))
                ->assertUnprocessable()
                ->assertJsonValidationErrors('invitation');
        }

        $this->assertDatabaseMissing('users', ['email' => 'nuovo@example.com']);
    }

    public function test_invitation_bound_to_an_email_rejects_other_addresses(): void
    {
        Invitation::factory()->withToken('riservato')->create(['email' => 'amico@example.com']);

        $this->postJson(route('api.v1.auth.register'), $this->registration(['invitation' => 'riservato']))
            ->assertUnprocessable()
            ->assertJsonValidationErrors('email');
    }

    public function test_registration_cannot_grant_admin_or_approval(): void
    {
        User::factory()->admin()->create();

        $this->postJson(route('api.v1.auth.register'), $this->registration(['is_admin' => true, 'approved_at' => now()]))
            ->assertCreated();

        $user = User::firstWhere('email', 'nuovo@example.com');
        $this->assertFalse($user->is_admin);
        $this->assertNull($user->approved_at);
    }

    public function test_login_without_spa_session_is_rejected_cleanly(): void
    {
        User::factory()->create(['email' => 'utente@example.com']);

        $this->withHeader('Referer', 'https://altro-sito.example')
            ->postJson(route('api.v1.auth.login'), ['email' => 'utente@example.com', 'password' => 'password'])
            ->assertBadRequest();
    }

    /**
     * @param  array<string, mixed>  $overrides
     * @return array<string, mixed>
     */
    private function registration(array $overrides = []): array
    {
        return [
            'name' => 'Nuovo Utente',
            'email' => 'nuovo@example.com',
            'password' => 'password-sicura',
            'password_confirmation' => 'password-sicura',
            ...$overrides,
        ];
    }
}
